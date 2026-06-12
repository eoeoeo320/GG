/* ============================================================
   study.js  —  학습 세션 관리 모듈
   - 세션 상태 관리, 카드 렌더링, 채점, 결과 기록
   - 카드 뒤집기 애니메이션 포함
============================================================ */

/* ----------------------------------------------------------
   세션 상태 (모듈 외부에서 직접 접근 금지)
---------------------------------------------------------- */
let _session = null;

/* ============================================================
   진입점 (공개)
============================================================ */

/**
 * 학습 설정 페이지 UI에서 설정을 읽어 세션 시작
 * index.html 의 onclick="startStudy()" 에서 호출
 */
function startStudy() {
  // ---- 설정 읽기 ----
  const selectedSubjects = _getSetupSubjects();
  const range      = _getSetupValue('#setup-range',      'all');
  const difficulty = _getSetupValue('#setup-mode',       'easy');

  // ---- 대상 문제 ID 목록 구성 ----
  const ids = _buildQueue({ subjects: selectedSubjects, range, difficulty });

  if (ids.length === 0) {
    showToast('조건에 맞는 문제가 없습니다.', 'warning');
    return;
  }

  Study.startWithIds(ids, {
    subjects:   selectedSubjects,
    range,
    difficulty,
    label: `${_difficultyLabel(difficulty)} 학습`,
  });
}

/**
 * 세션 종료 확인
 */
function confirmEndStudy() {
  showConfirm(
    '학습 종료',
    '현재 학습을 종료하시겠습니까?<br><span class="text-sec" style="font-size:12px">지금까지의 결과는 저장됩니다.</span>',
    () => Study.endSession()
  );
}

/* ============================================================
   Study 모듈 (네임스페이스)
============================================================ */
const Study = (() => {

  /* ----------------------------------------------------------
     특정 ID 목록으로 세션 시작 (오답노트 등에서 호출)
  ---------------------------------------------------------- */
  function startWithIds(ids, config) {
    if (!ids || ids.length === 0) {
      showToast('학습할 문제가 없습니다.', 'warning');
      return;
    }

    _session = {
      sessionId:              Storage.generateSessionId(),
      config:                 { ...config },
      queue:                  ids,
      currentIndex:           -1,
      results:                [],      // { questionId, correct, difficulty }
      startTime:              new Date(),
      // 현재 카드 상태
      currentBlankedKeywords: [],
      phase:                  'input', // 'input' | 'revealed' | 'graded'
      autoGradeResults:       null,    // list/step 자동채점 결과
      userFreeText:           '',      // 서술형 자유입력
    };

    // 타이틀 업데이트
    const titleEl = document.getElementById('study-title');
    const subEl   = document.getElementById('study-subtitle');
    if (titleEl) titleEl.textContent = config.label || '학습 중';
    if (subEl)   subEl.textContent   =
      `${ids.length}문제 · ${_difficultyLabel(config.difficulty)}`;

    navigate('study');
    _nextCard();
  }

  /* ----------------------------------------------------------
     다음 카드로 이동
  ---------------------------------------------------------- */
  function _nextCard() {
    while (true) {
      _session.currentIndex++;

      if (_session.currentIndex >= _session.queue.length) {
        endSession();
        return;
      }

      const qId = _session.queue[_session.currentIndex];
      const q   = Storage.getQuestion(qId);

      if (!q) continue;  // 삭제된 문제 스킵 — 재귀 대신 반복

      if (!q.analysis) {
        q.analysis = Analyzer.analyzeWithRules(q.question, q.answer);
      }

      const difficulty = _session.config.difficulty;
      const keywords   = q.analysis.keywords || [];
      // AI blanks 추출 (text 값이 없는 항목 제거)
      const aiBlankTexts = (q.analysis?.method === 'ai' && Array.isArray(q.analysis?.blanks))
        ? q.analysis.blanks.map(b => b?.text).filter(t => t && typeof t === 'string')
        : [];
      // AI blanks가 있으면 사용, 없으면 keywords로 폴백
      const blankSource = aiBlankTexts.length > 0 ? aiBlankTexts : keywords;

      _session.currentBlankedKeywords =
        difficulty === 'hell' ? [] : Analyzer.generateBlanks(blankSource, difficulty);

      _session.phase            = 'input';
      _session.autoGradeResults = null;
      _session.userFreeText     = '';

      _updateProgress();
      _renderCard(q);
      return;
    }
  }

  /* ----------------------------------------------------------
     진행률 업데이트
  ---------------------------------------------------------- */
  function _updateProgress() {
    const idx   = _session.currentIndex;
    const total = _session.queue.length;
    const pct   = Math.round(idx / total * 100);
    const correct = _session.results.filter(r => r.correct).length;

    const bar  = document.getElementById('study-progress-bar');
    const text = document.getElementById('study-progress-text');
    const score= document.getElementById('study-score-text');

    if (bar)   bar.style.width  = pct + '%';
    if (text)  text.textContent = `${idx + 1} / ${total}`;
    if (score) score.textContent= `정답: ${correct}`;
  }

  /* ----------------------------------------------------------
     카드 렌더링
  ---------------------------------------------------------- */
  function _renderCard(q) {
    const area  = document.getElementById('study-card-area');
    const ctrl  = document.getElementById('study-controls');
    if (!area || !ctrl) return;

    const difficulty = _session.config.difficulty;
    const blanked    = _session.currentBlankedKeywords;
    const analysis   = q.analysis;
    const keywords   = analysis.keywords || [];

    // ---- 앞면 내용 ----
    const frontBody = _renderFront(q, analysis, blanked, difficulty);

    // ---- 뒷면 내용 ----
    const backBody  = _renderBack(q, analysis);

    area.innerHTML = `
      <div class="flip-card">
        <div class="flip-card-inner" id="flip-inner">
          <div class="flip-card-front">
            <div class="study-stage-label">${_difficultyLabel(difficulty)}</div>
            <div class="study-question">${_esc(q.question)}</div>
            <div class="study-answer-area" id="study-front-body">
              ${frontBody}
            </div>
          </div>
          <div class="flip-card-back">
            <div class="back-label">정답 확인</div>
            <div class="study-question">${_esc(q.question)}</div>
            <div class="study-answer-area" id="study-back-body">
              ${backBody}
            </div>
          </div>
        </div>
      </div>`;

    _renderControls();

    // 첫 번째 빈칸에 포커스
    setTimeout(() => {
      const first = area.querySelector('.blank-input');
      if (first) first.focus();
    }, 100);
  }

  /* ----------------------------------------------------------
     앞면 렌더링
  ---------------------------------------------------------- */
  function _renderFront(q, analysis, blanked, difficulty) {
    const type = q.answerType;

    // 지옥 모드: 답안 정보 미표시
    if (difficulty === 'hell') {
      return `<div class="empty-state" style="padding:24px 0">
        <div style="font-size:32px;margin-bottom:8px">🔥</div>
        <div class="text-sec" style="font-size:13px">문제를 보고 답안을 떠올려 보세요</div>
      </div>`;
    }

    // 빈칸 없음 → 그대로 표시
    if (blanked.length === 0) {
      return `<div style="white-space:pre-wrap;line-height:1.8">${_esc(q.answer)}</div>`;
    }

    // AI 분석이면 항상 서술형 인라인 렌더링
    // → 원문 전체를 표시하고 해당 위치에 빈칸 처리
    if (analysis.method === 'ai') {
      return _renderDescriptiveFront(q.answer, analysis.keywords, blanked, difficulty);
    }
    if (type === 'step')  return _renderStepFront(analysis.keywords, blanked);
    if (type === 'list')  return _renderListFront(analysis.keywords, blanked);
    return _renderDescriptiveFront(q.answer, analysis.keywords, blanked, difficulty);
  }

  /* ---- 나열형 앞면 ---- */
  function _renderListFront(keywords, blanked) {
    const blankedSet = new Set(blanked);
    return keywords.map((kw, i) => {
      const num = `<span class="text-sec" style="min-width:20px;display:inline-block">${_circleNum(i + 1)}</span>`;
      if (blankedSet.has(kw)) {
        return `<div class="blank-line">${num}
          <input class="blank-input" type="text"
            data-index="${i}" data-answer="${_esc(kw)}"
            placeholder="${'＿'.repeat(Math.min(kw.length + 1, 8))}"
            autocomplete="off" spellcheck="false"
            style="min-width:${Math.max(80, kw.length * 16)}px;max-width:220px">
        </div>`;
      }
      return `<div class="blank-line">${num}<span>${_esc(kw)}</span></div>`;
    }).join('');
  }

  /* ---- 단계형 앞면 ---- */
  function _renderStepFront(keywords, blanked) {
    const blankedSet = new Set(blanked);
    const items = keywords.map((kw, i) => {
      if (blankedSet.has(kw)) {
        return `<input class="blank-input" type="text"
          data-index="${i}" data-answer="${_esc(kw)}"
          placeholder="${'＿'.repeat(Math.min(kw.length + 1, 6))}"
          autocomplete="off" spellcheck="false"
          style="min-width:${Math.max(70, kw.length * 15)}px;max-width:160px">`;
      }
      return `<span class="step-item">${_esc(kw)}</span>`;
    });

    const chain = items.map((item, i) =>
      i < items.length - 1
        ? item + `<span class="step-arrow"> → </span>`
        : item
    ).join('');

    return `<div class="step-chain" style="flex-wrap:wrap;gap:6px">${chain}</div>`;
  }

  /* ---- 서술형 앞면 ---- */
  function _renderDescriptiveFront(answer, keywords, blanked, difficulty) {
    // hard 모드: 빈칸이 너무 많으면 textarea 방식으로 전환
    if (difficulty === 'hard' && blanked.length > 4) {
      return `
        <div class="text-sec mb-2" style="font-size:12.5px">
          아래 핵심 내용을 떠올려 자유롭게 작성하세요 (선택)
        </div>
        <textarea class="study-textarea" id="free-textarea"
          placeholder="핵심 내용을 입력하세요..."
          rows="4" oninput="_session.userFreeText = this.value"></textarea>
        <div class="hint-keywords mt-2" id="hint-kw-area" style="display:none">
          ${blanked.map(kw => `<span class="hint-kw">${_esc(kw)}</span>`).join('')}
        </div>
        <button class="btn btn-ghost btn-sm mt-2" onclick="Study._toggleHint()">
          힌트 보기
        </button>`;
    }

    // 세그먼트 기반 인라인 빈칸
    const segments = Analyzer.parseAnswerSegments(answer, blanked);
    let blankIdx = 0;
    const html = segments.map(seg => {
      if (seg.type === 'text') {
        return `<span style="white-space:pre-wrap">${_esc(seg.content)}</span>`;
      }
      const kw = seg.keyword;
      const idx = blankIdx++;
      return `<input class="blank-input" type="text"
        data-index="${idx}" data-answer="${_esc(kw)}"
        placeholder="${'＿'.repeat(Math.min(kw.length + 1, 8))}"
        autocomplete="off" spellcheck="false"
        style="min-width:${Math.max(80, kw.length * 14)}px;max-width:200px">`;
    }).join('');

    return `<div class="blank-text" style="line-height:2.2">${html}</div>`;
  }

  /* ----------------------------------------------------------
     키워드 하이라이트 헬퍼
     원본 텍스트에서 세그먼트 분할 후 각각 HTML 이스케이프.
     HTML 이스케이프 전에 처리하므로 &·<·> 포함 키워드도 정확히 매칭됨.
  ---------------------------------------------------------- */
  function _highlightKeywords(text, keywords) {
    if (!keywords || keywords.length === 0) return _esc(text);
    const sorted = [...keywords].sort((a, b) => b.length - a.length);
    let segments = [{ isKw: false, content: text }];
    for (const kw of sorted) {
      const next = [];
      for (const seg of segments) {
        if (seg.isKw) { next.push(seg); continue; }
        const parts = seg.content.split(kw);
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) next.push({ isKw: false, content: parts[i] });
          if (i < parts.length - 1) next.push({ isKw: true, content: kw });
        }
      }
      segments = next;
    }
    return segments.map(s =>
      s.isKw
        ? `<span class="keyword-highlight">${_esc(s.content)}</span>`
        : _esc(s.content)
    ).join('');
  }

  /* ----------------------------------------------------------
     뒷면 렌더링 (정답 표시)
  ---------------------------------------------------------- */
  function _renderBack(q, analysis) {
    const keywords = analysis.keywords || [];
    const type     = q.answerType;

    const answerHtml = type === 'step'
      ? _renderStepAnswer(analysis.keywords)
      : `<div class="answer-reveal-box" style="white-space:pre-wrap">${_highlightKeywords(q.answer, keywords)}</div>`;

    const keywordChips = keywords.length > 0
      ? `<div class="mt-3">
           <div class="text-sec mb-1" style="font-size:11.5px">핵심 키워드</div>
           <div class="hint-keywords">
             ${keywords.map(kw => `<span class="hint-kw">${_esc(kw)}</span>`).join('')}
           </div>
         </div>`
      : '';

    return `
      ${answerHtml}
      ${keywordChips}
      <div id="back-grade-area" class="mt-3"></div>`;
  }

  /* ---- 단계형 답안 표시 (→ 체인) ---- */
  function _renderStepAnswer(keywords) {
    const chain = (keywords || []).map(kw =>
      `<span class="step-item">${_esc(kw)}</span>`
    ).join('<span class="step-arrow"> → </span>');
    return `<div class="step-chain mt-1" style="flex-wrap:wrap">${chain}</div>`;
  }

  /* ----------------------------------------------------------
     컨트롤 버튼 렌더링
  ---------------------------------------------------------- */
  function _renderControls() {
    const ctrl       = document.getElementById('study-controls');
    if (!ctrl) return;

    const difficulty = _session.config.difficulty;
    const q          = Storage.getQuestion(_session.queue[_session.currentIndex]);
    const type       = q?.answerType;
    const phase      = _session.phase;

    if (phase === 'input') {
      if (difficulty === 'hell' || (type === 'descriptive' && difficulty === 'hard' && _session.currentBlankedKeywords.length > 4)) {
        // 정답 보기 버튼
        ctrl.innerHTML = `
          <button class="btn btn-primary" onclick="Study.revealAnswer()">
            정답 보기
          </button>`;
      } else if (difficulty !== 'hell' && _session.currentBlankedKeywords.length > 0) {
        // 제출 + 정답보기
        ctrl.innerHTML = `
          <button class="btn btn-primary" onclick="Study.submitAnswer()">
            제출하기
          </button>
          <button class="btn btn-outline" onclick="Study.revealAnswer()">
            바로 정답 보기
          </button>`;
      } else {
        ctrl.innerHTML = `
          <button class="btn btn-primary" onclick="Study.revealAnswer()">
            정답 확인
          </button>`;
      }
    } else if (phase === 'revealed') {
      ctrl.innerHTML = `
        <div class="grade-buttons">
          <button class="grade-btn grade-btn-correct" onclick="Study.grade(true)">
            ⭕ 정답
          </button>
          <button class="grade-btn grade-btn-wrong" onclick="Study.grade(false)">
            ❌ 오답
          </button>
        </div>`;
    } else if (phase === 'graded') {
      ctrl.innerHTML = `
        <button class="btn btn-primary btn-lg" onclick="Study.next()">
          다음 문제 →
        </button>`;
    }
  }

  /* ----------------------------------------------------------
     제출 (나열형/단계형 자동채점)
  ---------------------------------------------------------- */
  function submitAnswer() {
    const q        = Storage.getQuestion(_session.queue[_session.currentIndex]);
    const blanked  = _session.currentBlankedKeywords;
    const type     = q.answerType;

    // 빈칸 입력값 수집
    const inputs  = document.querySelectorAll('#study-front-body .blank-input');
    const userInputs = [...inputs].map(el => el.value.trim());

    // 자동 채점
    let gradeResult;
    if (type === 'step') {
      gradeResult = Analyzer.gradeStepAnswer(userInputs, blanked);
    } else {
      gradeResult = Analyzer.gradeListAnswer(userInputs, blanked);
    }

    _session.autoGradeResults = gradeResult;

    // 입력 필드에 색상 피드백
    inputs.forEach((el, i) => {
      const res = gradeResult.results[i];
      if (res) {
        el.classList.add(res.correct ? 'correct' : 'wrong');
        el.disabled = true;
      }
    });

    // 뒷면 채점 결과 주입
    _populateBackGradeArea(q, gradeResult);

    // 카드 뒤집기
    setTimeout(() => {
      _flip();
      _session.phase = 'revealed';

      // 나열형/단계형은 점수 기반 자동 채점 권장
      const ctrl = document.getElementById('study-controls');
      if (ctrl) {
        const suggested = gradeResult.score >= 50;
        ctrl.innerHTML = `
          <div style="text-align:center;margin-bottom:12px">
            <span style="font-size:22px;font-weight:800;color:${suggested ? 'var(--success)' : 'var(--danger)'}">
              ${gradeResult.correctCount} / ${gradeResult.total}
            </span>
            <span class="text-sec" style="font-size:13px;margin-left:6px">정답 (${gradeResult.score}%)</span>
          </div>
          <div class="grade-buttons">
            <button class="grade-btn grade-btn-correct ${suggested ? 'btn-suggested' : ''}"
              onclick="Study.grade(true)">⭕ 정답 처리</button>
            <button class="grade-btn grade-btn-wrong ${!suggested ? 'btn-suggested' : ''}"
              onclick="Study.grade(false)">❌ 오답 처리</button>
          </div>`;
      }
    }, 300);
  }

  /* ----------------------------------------------------------
     정답 보기 (서술형/지옥 모드)
  ---------------------------------------------------------- */
  function revealAnswer() {
    const q       = Storage.getQuestion(_session.queue[_session.currentIndex]);
    const keywords = q.analysis?.keywords || [];

    // 서술형: 자유입력 텍스트로 키워드 포함률 계산
    const freeText = document.getElementById('free-textarea')?.value
      || document.querySelector('#study-front-body .blank-input')?.value
      || '';

    _session.userFreeText = freeText;

    // 뒷면 채점 보조 영역에 키워드 포함률 표시
    _populateDescriptiveBack(q, freeText, keywords);

    _flip();
    _session.phase = 'revealed';
    _renderControls();
  }

  /* ----------------------------------------------------------
     뒷면 채점 보조 영역 주입
  ---------------------------------------------------------- */
  function _populateBackGradeArea(q, gradeResult) {
    const area = document.getElementById('back-grade-area');
    if (!area) return;

    const rows = gradeResult.results.map(r => {
      const icon = r.correct
        ? `<span class="text-success">⭕</span>`
        : `<span class="text-danger">❌</span>`;
      const expected = r.correct
        ? `<span class="answer-correct-text">${_esc(r.expected)}</span>`
        : `<span class="text-danger" style="font-size:12.5px">정답: ${_esc(r.expected)}</span>`;
      const user = r.correct
        ? ''
        : `<span class="answer-wrong-text">${_esc(r.userInput || '(미입력)')}</span> `;

      return `<div style="padding:4px 0;font-size:13.5px">
        ${icon} ${user}${expected}
      </div>`;
    }).join('');

    area.innerHTML = rows
      ? `<div class="mt-2"><div class="text-sec mb-1" style="font-size:11.5px">채점 결과</div>${rows}</div>`
      : '';
  }

  function _populateDescriptiveBack(q, userText, keywords) {
    const area = document.getElementById('back-grade-area');
    if (!area) return;

    if (!userText || !userText.trim() || keywords.length === 0) {
      area.innerHTML = '';
      return;
    }

    const rate = Analyzer.calcKeywordInclusion(userText, keywords);
    if (!rate) { area.innerHTML = ''; return; }

    const missedHtml = rate.missedKws.length > 0
      ? `<div class="mt-1" style="font-size:12px">
           <span class="text-sec">미포함 키워드: </span>
           ${rate.missedKws.map(kw => `<span class="hint-kw">${_esc(kw)}</span>`).join(' ')}
         </div>`
      : '';

    area.innerHTML = `
      <div class="keyword-rate ${rate.level}">
        ${rate.msg}${missedHtml}
      </div>`;
  }

  /* ----------------------------------------------------------
     힌트 토글 (서술형 hard 모드)
  ---------------------------------------------------------- */
  function _toggleHint() {
    const area = document.getElementById('hint-kw-area');
    if (!area) return;
    area.style.display = area.style.display === 'none' ? 'flex' : 'none';
  }

  /* ----------------------------------------------------------
     카드 뒤집기
  ---------------------------------------------------------- */
  function _flip() {
    const inner = document.getElementById('flip-inner');
    if (inner) inner.classList.add('flipped');
  }

  /* ----------------------------------------------------------
     채점 (O/X)
  ---------------------------------------------------------- */
  function grade(correct) {
    const qId        = _session.queue[_session.currentIndex];
    const difficulty = _session.config.difficulty;

    // 결과 기록
    _session.results.push({ questionId: qId, correct, difficulty });
    _session.phase = 'graded';

    // 스토리지 기록
    const { becameMemorized } = Storage.recordStudyResult(
      qId, correct, difficulty, _session.sessionId
    );

    // 오답노트 처리
    if (correct) {
      const removed = Storage.markWrongNoteCorrect(qId);
      if (removed) showToast('3연속 정답 — 오답노트에서 제거되었습니다.', 'success');
    } else {
      Storage.addWrongNote(qId);
    }

    // 암기완료 달성 알림
    if (becameMemorized) {
      showToast('암기완료! 이 문제를 마스터했습니다. 🎉', 'success');
    }

    _updateProgress();
    _renderControls();
  }

  /* ----------------------------------------------------------
     다음 문제
  ---------------------------------------------------------- */
  function next() {
    _nextCard();
  }

  /* ----------------------------------------------------------
     세션 종료
  ---------------------------------------------------------- */
  function endSession() {
    if (!_session) { navigate('dashboard'); return; }
    _showSessionSummary();
  }

  /* ----------------------------------------------------------
     세션 종료 요약 팝업
  ---------------------------------------------------------- */
  function _showSessionSummary() {
    const results    = _session.results;
    const total      = _session.queue.length;
    const answered   = results.length;
    const correct    = results.filter(r => r.correct).length;
    const wrong      = answered - correct;
    const pct        = answered > 0 ? Math.round(correct / answered * 100) : 0;
    const elapsed    = Math.round((new Date() - _session.startTime) / 1000);
    const timeStr    = elapsed >= 60
      ? `${Math.floor(elapsed / 60)}분 ${elapsed % 60}초`
      : `${elapsed}초`;

    const memorizedCount = [...new Set(
      results.map(r => r.questionId).filter(id => {
        const rec = Storage.getRecord(id);
        return rec && rec.status === 'memorized';
      })
    )].length;

    const pctColor = pct >= 80 ? 'var(--success)'
                   : pct >= 50 ? 'var(--warning)'
                   : 'var(--danger)';

    const body = document.getElementById('session-end-body');
    if (body) {
      body.innerHTML = `
        <div class="session-summary">
          <div class="session-score" style="color:${pctColor}">${pct}%</div>
          <div class="session-score-label">정답률</div>

          <div class="session-stats-row">
            <div class="session-stat-item">
              <div class="session-stat-value text-success">${correct}</div>
              <div class="session-stat-label">정답</div>
            </div>
            <div class="session-stat-item">
              <div class="session-stat-value text-danger">${wrong}</div>
              <div class="session-stat-label">오답</div>
            </div>
            <div class="session-stat-item">
              <div class="session-stat-value text-sec">${total - answered}</div>
              <div class="session-stat-label">미채점</div>
            </div>
            <div class="session-stat-item">
              <div class="session-stat-value">${timeStr}</div>
              <div class="session-stat-label">소요시간</div>
            </div>
          </div>

          ${memorizedCount > 0 ? `
          <div class="memorized-notice">
            🎉 이번 세션으로 암기완료 ${memorizedCount}문제 달성!
          </div>` : ''}

          <div class="text-sec mt-3" style="font-size:12.5px">
            ${answered} / ${total} 문제 채점 완료
          </div>
        </div>`;
    }

    openModal('modal-session-end');
    _session = null;
  }

  /* ----------------------------------------------------------
     내부 유틸
  ---------------------------------------------------------- */
  function _circleNum(n) {
    const circles = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮';
    return n <= circles.length ? circles[n - 1] : `${n}.`;
  }

  function _esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ----------------------------------------------------------
     공개 API
  ---------------------------------------------------------- */
  return {
    startWithIds,
    submitAnswer,
    revealAnswer,
    grade,
    next,
    endSession,
    _toggleHint,   // HTML onclick 참조
  };

})();

/* ============================================================
   학습 설정 페이지 — 셋업 UI 헬퍼 (app.js 보다 먼저 로드 필요)
============================================================ */

function _buildQueue({ subjects, range, difficulty }) {
  let questions = Storage.getQuestions();

  // 과목 필터
  if (subjects && subjects.length > 0 && !subjects.includes('all')) {
    questions = questions.filter(q => subjects.includes(q.subject));
  }

  // 범위 필터
  if (range === 'wrong') {
    const wrongIds = new Set(Storage.getWrongNotes().map(n => n.questionId));
    questions = questions.filter(q => wrongIds.has(q.id));
  } else if (range === 'preexam') {
    const records  = Storage.getRecords();
    const wrongIds = new Set(Storage.getWrongNotes().map(n => n.questionId));
    questions = questions.filter(q => {
      const status = records[q.id]?.status || 'unseen';
      return status !== 'memorized' && (status === 'learning' || wrongIds.has(q.id));
    });
  }

  // 셔플
  return questions.map(q => q.id).sort(() => Math.random() - 0.5);
}

function _getSetupSubjects() {
  const active = document.querySelectorAll('#setup-subjects .type-btn.active');
  const vals   = [...active].map(b => b.dataset.subject);
  return vals.includes('all') ? [] : vals;
}

function _getSetupValue(selector, defaultVal) {
  const el = document.querySelector(`${selector} .active, ${selector} [data-value].selected`);
  return el?.dataset?.value || el?.dataset?.subject || defaultVal;
}

function _difficultyLabel(d) {
  return { easy:'1단계 (쉬움)', normal:'2단계 (보통)', hard:'3단계 (어려움)', hell:'4단계 (지옥)' }[d] || d;
}

/* 세션 진행 카운트 업데이트용 외부 접근 */
function studyWrongNotes() {
  WrongNote.studyAll();
}
