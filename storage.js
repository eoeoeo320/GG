/* ============================================================
   storage.js  —  LocalStorage 전용 모듈
   모든 데이터 읽기/쓰기는 이 모듈을 통해 수행한다.
============================================================ */

const Storage = (() => {

  /* ---- 스토리지 키 ---- */
  const KEYS = {
    QUESTIONS:     'exam_questions',
    RECORDS:       'exam_study_records',
    WRONG_NOTES:   'exam_wrong_notes',
    SETTINGS:      'exam_settings',
    API_KEY:       'exam_api_key',           // 백업 제외
    SUBJECT_COLORS:'exam_subject_colors',
  };

  /* ---- 기본값 ---- */
  const DEFAULT_SETTINGS = {
    geminiModel:       'gemini-2.5-flash',
    darkMode:          false,
    defaultDifficulty: 'easy',
  };

  const DEFAULT_RECORD = {
    status:               'unseen',   // 'unseen' | 'learning' | 'memorized'
    totalAttempts:        0,
    correctAttempts:      0,
    lastStudied:          null,
    recentResults:        [],         // 최근 10회 boolean[]
    hardCorrectSessions:  [],         // 암기완료 판정용: [{sessionId, date, correct}]
    history:              [],         // 최근 50회 세션 기록
  };

  /* ----------------------------------------------------------
     내부 헬퍼
  ---------------------------------------------------------- */
  let _skipSync = false; // importFromCloud 중 Supabase 루프 방지

  function _get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function _set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      // 데이터 변경 시 Supabase 자동 동기화 예약 (import 중엔 생략)
      if (!_skipSync && typeof SupabaseSync !== 'undefined') {
        SupabaseSync.schedulePush();
      }
      return true;
    } catch (e) {
      if (e.name === 'QuotaExceededError' && typeof showToast === 'function') {
        showToast('저장 공간이 부족합니다. 설정 → 저장 용량을 확인하세요.', 'danger');
      }
      console.error('[Storage] 쓰기 실패:', key, e);
      return false;
    }
  }

  function _remove(key) {
    localStorage.removeItem(key);
  }

  /* ----------------------------------------------------------
     ID 생성
  ---------------------------------------------------------- */
  function generateId() {
    return 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  }

  function generateSessionId() {
    return 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  /* ----------------------------------------------------------
     문제 (Questions)
  ---------------------------------------------------------- */
  function getQuestions() {
    return _get(KEYS.QUESTIONS) || [];
  }

  function saveQuestions(questions) {
    return _set(KEYS.QUESTIONS, questions);
  }

  function getQuestion(id) {
    return getQuestions().find(q => q.id === id) || null;
  }

  function addQuestion(data) {
    const questions = getQuestions();
    const now = new Date().toISOString();
    const q = {
      id:           generateId(),
      subject:      (data.subject || '').trim(),
      question:     (data.question || '').trim(),
      answer:       (data.answer || '').trim(),
      answerType:   data.answerType || 'descriptive',
      subjectColor: data.subjectColor || getAutoColor(data.subject),
      createdAt:    now,
      updatedAt:    now,
      analysis:     data.analysis || null,
    };
    questions.push(q);
    saveQuestions(questions);

    // 과목 색상 자동 등록
    if (q.subject && q.subjectColor) {
      saveSubjectColor(q.subject, q.subjectColor);
    }

    return q;
  }

  function updateQuestion(id, data) {
    const questions = getQuestions();
    const idx = questions.findIndex(q => q.id === id);
    if (idx === -1) return null;

    const now = new Date().toISOString();
    questions[idx] = {
      ...questions[idx],
      subject:      (data.subject      ?? questions[idx].subject).trim(),
      question:     (data.question     ?? questions[idx].question).trim(),
      answer:       (data.answer       ?? questions[idx].answer).trim(),
      answerType:   data.answerType    ?? questions[idx].answerType,
      subjectColor: data.subjectColor  ?? questions[idx].subjectColor,
      updatedAt:    now,
    };

    if (data.analysis !== undefined) {
      questions[idx].analysis = data.analysis;
    }

    saveQuestions(questions);

    if (questions[idx].subject && questions[idx].subjectColor) {
      saveSubjectColor(questions[idx].subject, questions[idx].subjectColor);
    }

    return questions[idx];
  }

  function deleteQuestion(id) {
    const questions = getQuestions().filter(q => q.id !== id);
    saveQuestions(questions);

    // 연관 학습 기록 정리
    const records = getRecords();
    delete records[id];
    saveRecords(records);

    // 오답노트 정리
    const wrongs = getWrongNotes().filter(w => w.questionId !== id);
    saveWrongNotes(wrongs);
  }

  /* ----------------------------------------------------------
     과목 색상 (Subject Colors)
  ---------------------------------------------------------- */
  const PALETTE = [
    '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
    '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#6366f1',
  ];

  function getSubjectColors() {
    return _get(KEYS.SUBJECT_COLORS) || {};
  }

  function saveSubjectColor(subject, color) {
    const map = getSubjectColors();
    map[subject] = color;
    _set(KEYS.SUBJECT_COLORS, map);
  }

  function getAutoColor(subject) {
    if (!subject) return PALETTE[0];
    const map = getSubjectColors();
    if (map[subject]) return map[subject];

    // 등록된 과목 수를 기반으로 다음 색상 자동 배정
    const usedColors = Object.values(map);
    const nextIdx = usedColors.length % PALETTE.length;
    return PALETTE[nextIdx];
  }

  function getSubjects() {
    const questions = getQuestions();
    const subjects = [...new Set(questions.map(q => q.subject).filter(Boolean))];
    const colorMap = getSubjectColors();
    return subjects.map(s => ({ name: s, color: colorMap[s] || PALETTE[0] }));
  }

  /* ----------------------------------------------------------
     학습 기록 (Study Records)
  ---------------------------------------------------------- */
  function getRecords() {
    return _get(KEYS.RECORDS) || {};
  }

  function saveRecords(records) {
    return _set(KEYS.RECORDS, records);
  }

  function getRecord(questionId) {
    const records = getRecords();
    const base    = records[questionId] || DEFAULT_RECORD;
    return {
      ...DEFAULT_RECORD,
      ...base,
      recentResults:       [...(base.recentResults || [])],
      hardCorrectSessions: (base.hardCorrectSessions || []).map(s => ({ ...s })),
      history:             (base.history || []).map(h => ({ ...h })),
    };
  }

  function saveRecord(questionId, record) {
    const records = getRecords();
    records[questionId] = record;
    return saveRecords(records);
  }

  /**
   * 학습 결과를 기록하고 암기완료 여부를 판정한다.
   *
   * @param {string}  questionId
   * @param {boolean} correct      - 정답 여부
   * @param {string}  difficulty   - 'easy' | 'normal' | 'hard' | 'hell'
   * @param {string}  sessionId    - 현재 세션 ID
   * @returns {{ record, becameMemorized }}
   */
  function recordStudyResult(questionId, correct, difficulty, sessionId) {
    const record = getRecord(questionId);
    const now = new Date().toISOString();
    const today = now.slice(0, 10); // YYYY-MM-DD

    // 기본 통계
    record.totalAttempts += 1;
    if (correct) record.correctAttempts += 1;
    record.lastStudied = now;

    // 최근 결과 (최대 10개 유지)
    record.recentResults.push(correct);
    if (record.recentResults.length > 10) record.recentResults.shift();

    // 상태: 미학습 → 학습중
    if (record.status === 'unseen') record.status = 'learning';

    // 히스토리 (최대 50개)
    record.history.push({ date: now, difficulty, sessionId, correct });
    if (record.history.length > 50) record.history.shift();

    // ---- 암기완료 판정 ----
    let becameMemorized = false;

    if (difficulty === 'hard' || difficulty === 'hell') {
      if (correct) {
        // 같은 세션이 이미 있으면 추가하지 않음 (세션 내 중복 방지)
        const alreadyInSession = record.hardCorrectSessions
          .some(s => s.sessionId === sessionId);

        if (!alreadyInSession) {
          record.hardCorrectSessions.push({ sessionId, date: today, correct: true });
          // 연속만 유지 (오답으로 끊기지 않았으므로 그대로 누적)
        }
      } else {
        // 어려움/지옥 오답 → 연속 스트릭 초기화
        record.hardCorrectSessions = [];
        // 암기완료였다면 학습중으로 복귀
        if (record.status === 'memorized') record.status = 'learning';
      }

      // 암기완료 조건 확인
      if (record.status !== 'memorized' && _checkMemorized(record.hardCorrectSessions)) {
        record.status = 'memorized';
        becameMemorized = true;
      }
    }

    saveRecord(questionId, record);
    return { record, becameMemorized };
  }

  /**
   * 암기완료 조건 판정
   * 조건: 연속 3회 정답 & 세션 ID 모두 다름 & 2일 이상에 걸쳐 달성
   */
  function _checkMemorized(sessions) {
    if (sessions.length < 3) return false;

    const last3 = sessions.slice(-3);

    // 모두 다른 세션 ID
    const ids = last3.map(s => s.sessionId);
    if (new Set(ids).size < 3) return false;

    // 날짜가 2일 이상(서로 다른 날짜가 2개 이상)
    const dates = last3.map(s => s.date);
    if (new Set(dates).size < 2) return false;

    return true;
  }

  /* ----------------------------------------------------------
     오답노트 (Wrong Notes)
  ---------------------------------------------------------- */
  function getWrongNotes() {
    return _get(KEYS.WRONG_NOTES) || [];
  }

  function saveWrongNotes(notes) {
    return _set(KEYS.WRONG_NOTES, notes);
  }

  function getWrongNote(questionId) {
    return getWrongNotes().find(w => w.questionId === questionId) || null;
  }

  /**
   * 오답 기록. recentResults에 false 추가.
   */
  function addWrongNote(questionId) {
    const notes = getWrongNotes();
    const now = new Date().toISOString();
    const idx = notes.findIndex(w => w.questionId === questionId);

    if (idx === -1) {
      notes.push({
        questionId,
        wrongCount:    1,
        lastWrong:     now,
        recentResults: [false],
      });
    } else {
      notes[idx].wrongCount += 1;
      notes[idx].lastWrong   = now;
      notes[idx].recentResults.push(false);
      if (notes[idx].recentResults.length > 3) notes[idx].recentResults.shift();
    }

    saveWrongNotes(notes);
  }

  /**
   * 정답 기록. recentResults에 true 추가.
   * 최근 3회 연속 정답이면 오답노트에서 자동 제거.
   * @returns {boolean} 제거 여부
   */
  function markWrongNoteCorrect(questionId) {
    const notes = getWrongNotes();
    const idx = notes.findIndex(w => w.questionId === questionId);
    if (idx === -1) return false;

    notes[idx].recentResults.push(true);
    if (notes[idx].recentResults.length > 3) notes[idx].recentResults.shift();

    const last3 = notes[idx].recentResults.slice(-3);
    const autoRemove = last3.length === 3 && last3.every(r => r === true);

    if (autoRemove) {
      notes.splice(idx, 1);
    }

    saveWrongNotes(notes);
    return autoRemove;
  }

  function removeWrongNote(questionId) {
    saveWrongNotes(getWrongNotes().filter(w => w.questionId !== questionId));
  }

  /* ----------------------------------------------------------
     설정 (Settings)
  ---------------------------------------------------------- */
  function getSettings() {
    return { ...DEFAULT_SETTINGS, ...(_get(KEYS.SETTINGS) || {}) };
  }

  function saveSettings(settings) {
    const current = getSettings();
    return _set(KEYS.SETTINGS, { ...current, ...settings });
  }

  /* ----------------------------------------------------------
     Gemini API Key  (별도 키, 백업 절대 포함 안 함)
  ---------------------------------------------------------- */
  function getApiKey() {
    return localStorage.getItem(KEYS.API_KEY) || '';
  }

  function saveApiKey(key) {
    if (key && key.trim()) {
      localStorage.setItem(KEYS.API_KEY, key.trim());
    }
  }

  function deleteApiKey() {
    _remove(KEYS.API_KEY);
  }

  /* ----------------------------------------------------------
     내보내기 / 가져오기
  ---------------------------------------------------------- */
  function exportData() {
    return {
      appVersion:  '1.0.0',
      exportedAt:  new Date().toISOString(),
      data: {
        questions:     getQuestions(),
        records:       getRecords(),
        wrongNotes:    getWrongNotes(),
        subjectColors: getSubjectColors(),
        settings: {
          geminiModel: getSettings().geminiModel,
          darkMode:    getSettings().darkMode,
          // API Key 절대 포함 안 함
        },
      },
    };
  }

  function importData(payload) {
    if (!payload || !payload.data) throw new Error('유효하지 않은 백업 파일입니다.');

    const { questions, records, wrongNotes, subjectColors, settings } = payload.data;

    // records 타입 검증: 순수 객체여야 함 (배열 · null 불가)
    if (records !== undefined && records !== null &&
        (typeof records !== 'object' || Array.isArray(records))) {
      throw new Error('학습기록 형식이 올바르지 않습니다.');
    }

    if (Array.isArray(questions))    saveQuestions(questions);
    if (records)                     saveRecords(records);
    if (Array.isArray(wrongNotes))   saveWrongNotes(wrongNotes);
    if (subjectColors && typeof subjectColors === 'object' && !Array.isArray(subjectColors)) {
      _set(KEYS.SUBJECT_COLORS, subjectColors);
    }
    if (settings) {
      saveSettings({
        geminiModel: settings.geminiModel,
        darkMode:    settings.darkMode,
      });
    }

    // API Key는 현재 저장된 값 유지 (덮어쓰지 않음)
  }

  function resetAllData() {
    _remove(KEYS.QUESTIONS);
    _remove(KEYS.RECORDS);
    _remove(KEYS.WRONG_NOTES);
    _remove(KEYS.SETTINGS);
    _remove(KEYS.SUBJECT_COLORS);
    // API Key는 초기화 대상에서 제외
  }

  /* ----------------------------------------------------------
     클라우드 동기화: Supabase pull 후 localStorage 일괄 교체
     _skipSync = true 로 재업로드 루프를 막는다
  ---------------------------------------------------------- */
  function importFromCloud(data) {
    _skipSync = true;
    try {
      if (Array.isArray(data.questions))
        saveQuestions(data.questions);
      if (data.records && typeof data.records === 'object' && !Array.isArray(data.records))
        saveRecords(data.records);
      if (Array.isArray(data.wrong_notes))
        saveWrongNotes(data.wrong_notes);
      if (data.settings && typeof data.settings === 'object')
        _set(KEYS.SETTINGS, data.settings);         // 전체 교체 (merge 아님)
      if (data.subject_colors && typeof data.subject_colors === 'object')
        _set(KEYS.SUBJECT_COLORS, data.subject_colors);
    } finally {
      _skipSync = false;
    }
  }

  /* ----------------------------------------------------------
     저장 용량 계산
  ---------------------------------------------------------- */
  function calcStorageUsage() {
    let totalBytes = 0;
    const breakdown = {};

    for (const [name, key] of Object.entries(KEYS)) {
      const val = localStorage.getItem(key);
      if (val) {
        // UTF-16 인코딩: 문자당 2바이트
        const bytes = val.length * 2;
        totalBytes += bytes;
        breakdown[name] = bytes;
      } else {
        breakdown[name] = 0;
      }
    }

    // localStorage 일반 한도: 5MB
    const limitBytes = 5 * 1024 * 1024;

    return {
      usedBytes:  totalBytes,
      limitBytes,
      usedKB:     (totalBytes / 1024).toFixed(1),
      limitKB:    (limitBytes / 1024).toFixed(0),
      usedMB:     (totalBytes / 1024 / 1024).toFixed(2),
      percent:    Math.min(100, ((totalBytes / limitBytes) * 100).toFixed(1)),
      breakdown,
    };
  }

  /* ----------------------------------------------------------
     통계 계산 헬퍼
  ---------------------------------------------------------- */
  function calcStats() {
    const questions = getQuestions();
    const records   = getRecords();
    const wrongs    = getWrongNotes();

    const total      = questions.length;
    let unseen = 0, learning = 0, memorized = 0;
    let totalAttempts = 0, correctAttempts = 0;

    questions.forEach(q => {
      const r = records[q.id];
      if (!r || r.status === 'unseen')    unseen++;
      else if (r.status === 'learning')   learning++;
      else if (r.status === 'memorized')  memorized++;

      if (r) {
        totalAttempts   += r.totalAttempts   || 0;
        correctAttempts += r.correctAttempts || 0;
      }
    });

    const correctRate  = totalAttempts > 0
      ? Math.round(correctAttempts / totalAttempts * 100) : 0;
    const memorizeRate = total > 0
      ? Math.round(memorized / total * 100) : 0;

    return {
      total, unseen, learning, memorized,
      wrongCount: wrongs.length,
      totalAttempts, correctAttempts,
      correctRate, memorizeRate,
    };
  }

  /* ----------------------------------------------------------
     과목별 통계
  ---------------------------------------------------------- */
  function calcSubjectStats() {
    const questions    = getQuestions();
    const records      = getRecords();
    const subjectMap   = {};

    questions.forEach(q => {
      const sub = q.subject || '미분류';
      if (!subjectMap[sub]) {
        subjectMap[sub] = {
          name: sub, color: q.subjectColor || '#3b82f6',
          total: 0, memorized: 0, correct: 0, attempts: 0,
        };
      }
      subjectMap[sub].total++;
      const r = records[q.id];
      if (r) {
        if (r.status === 'memorized') subjectMap[sub].memorized++;
        subjectMap[sub].correct  += r.correctAttempts || 0;
        subjectMap[sub].attempts += r.totalAttempts   || 0;
      }
    });

    return Object.values(subjectMap).sort((a, b) => b.total - a.total);
  }

  /* ----------------------------------------------------------
     공개 API
  ---------------------------------------------------------- */
  return {
    // 식별자
    generateId,
    generateSessionId,
    PALETTE,

    // 문제
    getQuestions,
    saveQuestions,
    getQuestion,
    addQuestion,
    updateQuestion,
    deleteQuestion,

    // 과목
    getSubjectColors,
    saveSubjectColor,
    getAutoColor,
    getSubjects,

    // 학습 기록
    getRecords,
    saveRecords,
    getRecord,
    saveRecord,
    recordStudyResult,

    // 오답노트
    getWrongNotes,
    saveWrongNotes,
    getWrongNote,
    addWrongNote,
    markWrongNoteCorrect,
    removeWrongNote,

    // 설정
    getSettings,
    saveSettings,

    // API Key
    getApiKey,
    saveApiKey,
    deleteApiKey,

    // 백업
    exportData,
    importData,
    resetAllData,

    // 클라우드 동기화
    importFromCloud,

    // 용량
    calcStorageUsage,

    // 통계
    calcStats,
    calcSubjectStats,
  };

})();
