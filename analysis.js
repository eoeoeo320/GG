/* ============================================================
   analysis.js  —  규칙 기반 답안 분석 모듈
   AI 없이 100% 동작하는 규칙 기반 분석을 담당한다.
   DOM 조작 없이 순수 데이터만 처리한다.
============================================================ */

const Analyzer = (() => {

  /* ----------------------------------------------------------
     상수
  ---------------------------------------------------------- */
  const CIRCLED_RE  = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/;
  const CIRCLED_SPLIT = /([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])/;

  const STEP_TRIGGER_WORDS = [
    '단계', '순서', '프로세스', '절차', '과정', '단계별', '흐름',
  ];

  const KOR_SUFFIX_RE = /[가-힣]{2,10}(?:론|이론|제도|주의|원칙|방법|방식|형태|유형|효과|법칙|정책|전략|학파|학설|모형|모델|방안|체계|기법|접근)/g;

  /* ----------------------------------------------------------
     1. 답안 유형 자동 판별
     우선순위: 단계형 > 나열형 > 서술형
  ---------------------------------------------------------- */
  function detectAnswerType(question, answer) {
    const q = question || '';
    const a = answer   || '';

    // ---- 단계형 ----
    if (a.includes('→') || a.includes('->')) return 'step';
    if (/\d+\s*단계/.test(a)) return 'step';
    if (STEP_TRIGGER_WORDS.some(w => q.includes(w))) return 'step';
    if (STEP_TRIGGER_WORDS.some(w => a.includes(w) && a.includes('\n'))) return 'step';

    // ---- 나열형 ----
    if (CIRCLED_RE.test(a)) return 'list';

    // 번호 목록: "1. " "1) " "(1) "
    if (/^\s*\d+[.)]\s+\S/m.test(a)) return 'list';
    if (/^\s*[(（]\d+[)）]\s+\S/m.test(a)) return 'list';

    // 쉼표 나열 3개 이상
    const commaCount = (a.match(/[,，、]/g) || []).length;
    if (commaCount >= 2) return 'list';

    // 줄바꿈 3줄 이상
    const nonEmptyLines = a.split('\n').filter(l => l.trim()).length;
    if (nonEmptyLines >= 3) return 'list';

    return 'descriptive';
  }

  /* ----------------------------------------------------------
     2. 키워드 추출
  ---------------------------------------------------------- */
  function extractKeywords(answer, type) {
    if (!answer) return [];
    if (type === 'step')  return extractStepItems(answer);
    if (type === 'list')  return extractListItems(answer);
    return extractDescriptiveKeywords(answer);
  }

  /* ---- 단계형: → 또는 번호 기반 ---- */
  function extractStepItems(answer) {
    if (answer.includes('→')) {
      return answer
        .split('→')
        .map(s => s.trim())
        .filter(Boolean);
    }
    if (answer.includes('->')) {
      return answer
        .split('->')
        .map(s => s.trim())
        .filter(Boolean);
    }
    // 화살표 없으면 나열형으로 처리
    return extractListItems(answer);
  }

  /* ---- 나열형 ---- */
  function extractListItems(answer) {
    // 원문자 ①②③...
    if (CIRCLED_RE.test(answer)) {
      const parts = answer.split(CIRCLED_SPLIT);
      const items = [];
      let current = null;
      for (const part of parts) {
        if (CIRCLED_RE.test(part)) {
          if (current !== null) items.push(current.trim());
          current = '';
        } else if (current !== null) {
          current += part;
        }
      }
      if (current !== null && current.trim()) items.push(current.trim());
      if (items.length > 0) return items.filter(Boolean);
    }

    // 번호 목록 "1. " "1) " "(1) "
    const numberedRe = /^\s*(?:[(（]\d+[)）]|\d+[.)、])\s*(.+)$/mg;
    const numberedMatches = [...answer.matchAll(numberedRe)];
    if (numberedMatches.length >= 2) {
      return numberedMatches.map(m => m[1].trim()).filter(Boolean);
    }

    // 쉼표 나열 (줄바꿈 없거나 단일 행)
    const singleLine = answer.trim().replace(/\n/g, ' ').trim();
    const commaItems = singleLine.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    if (commaItems.length >= 2) return commaItems;

    // 줄 기반 (-, ·, •, * 제거)
    const lines = answer
      .split('\n')
      .map(l => l.trim().replace(/^[-·•*]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter(l => l.length > 0);

    if (lines.length >= 2) return lines;

    return answer.trim() ? [answer.trim()] : [];
  }

  /* ---- 서술형: 핵심 개념 추출 ---- */
  function extractDescriptiveKeywords(answer) {
    const collected = [];

    // 1. 괄호 내 용어: ( ) （ ） 「 」 『 』
    const bracketRe = /[（(「『](.*?)[）)」』]/g;
    let m;
    while ((m = bracketRe.exec(answer)) !== null) {
      const t = m[1].trim();
      if (t.length >= 2) collected.push(t);
    }

    // 2. 영문 이론명/학자명 (대문자로 시작하는 단어 또는 연속 단어)
    const engRe = /[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*/g;
    while ((m = engRe.exec(answer)) !== null) {
      if (m[0].length >= 3) collected.push(m[0]);
    }

    // 3. 한국어 학술 복합명사 (~론, ~이론, ~주의 등)
    const korMatches = answer.match(KOR_SUFFIX_RE) || [];
    collected.push(...korMatches);

    // 4. 숫자 포함 핵심구 (예: 30%, 3가지, 1단계)
    const numRe = /\d+(?:\.\d+)?(?:\s*[%％개가지명배층회단])?/g;
    while ((m = numRe.exec(answer)) !== null) {
      const t = m[0].trim();
      if (t.length >= 2) collected.push(t);
    }

    // 5. 쌍따옴표 / 따옴표 강조 구문
    const quoteRe = /[""''](.+?)[""'']/g;
    while ((m = quoteRe.exec(answer)) !== null) {
      const t = m[1].trim();
      if (t.length >= 2) collected.push(t);
    }

    // 중복 제거, 짧은 것 필터, 최대 12개
    return [...new Set(collected)]
      .filter(kw => kw && kw.trim().length >= 2)
      .slice(0, 12);
  }

  /* ----------------------------------------------------------
     3. 규칙 기반 분석 결과 생성
  ---------------------------------------------------------- */
  function analyzeWithRules(question, answer) {
    const answerType = detectAnswerType(question, answer);
    const keywords   = extractKeywords(answer, answerType);

    // 콜론 패턴 ("개념 : 내용") 항목은 양쪽을 별도 빈칸 후보로 분리
    const blanks = keywords.flatMap(kw => {
      const colonIdx = kw.indexOf(' : ');
      if (colonIdx > 0) {
        const left  = kw.slice(0, colonIdx).trim();
        const right = kw.slice(colonIdx + 3).trim();
        if (left && right) {
          return [
            { text: left,  importance: 'high' },
            { text: right, importance: 'high' },
          ];
        }
      }
      return [{ text: kw, importance: 'high' }];
    });

    return {
      method:      'rule',
      model:       null,
      analyzedAt:  new Date().toISOString(),
      answerType,
      keywords,
      keyPoints:   blanks.map(b => b.text),
      blanks,
      structure:   _structureDesc(answerType, keywords.length),
    };
  }

  function _structureDesc(type, count) {
    if (type === 'list') return `나열형 (${count}개 항목)`;
    if (type === 'step') return `단계형 (${count}단계)`;
    return '서술형';
  }

  function getTypeName(type) {
    return { list: '나열형', step: '단계형', descriptive: '서술형' }[type] || '서술형';
  }

  /* ----------------------------------------------------------
     4. 빈칸 대상 키워드 선택
     difficulty: 'easy'(30%) | 'normal'(60%) | 'hard'(100%) | 'hell'(전체 가림)
  ---------------------------------------------------------- */
  function generateBlanks(keywords, difficulty) {
    if (!keywords || keywords.length === 0) return [];

    let count;
    if (difficulty === 'easy')   count = Math.max(1, Math.ceil(keywords.length * 0.3));
    else if (difficulty === 'normal') count = Math.max(1, Math.ceil(keywords.length * 0.6));
    else                              count = keywords.length;  // hard, hell 모두 전체

    // 셔플 후 count개 선택
    const shuffled = [...keywords].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  /* ----------------------------------------------------------
     5. 서술형 답안 세그먼트 분리 (빈칸 위치 계산)
     반환: [{ type:'text'|'blank', content:string, keyword?:string }]
     study.js에서 이 세그먼트 배열을 사용해 입력 필드를 렌더링한다.
  ---------------------------------------------------------- */
  function parseAnswerSegments(answer, blankedKeywords) {
    if (!blankedKeywords || blankedKeywords.length === 0) {
      return [{ type: 'text', content: answer }];
    }

    // 긴 키워드부터 처리해 부분 매치 방지
    const sorted = [...blankedKeywords].sort((a, b) => b.length - a.length);

    let segments = [{ type: 'text', content: answer }];

    for (const kw of sorted) {
      if (!kw) continue;
      const next = [];

      for (const seg of segments) {
        if (seg.type === 'blank') { next.push(seg); continue; }

        const parts = seg.content.split(kw);
        if (parts.length === 1) { next.push(seg); continue; }

        parts.forEach((part, i) => {
          if (part) next.push({ type: 'text', content: part });
          if (i < parts.length - 1) next.push({ type: 'blank', keyword: kw });
        });
      }

      segments = next;
    }

    return segments;
  }

  /* ----------------------------------------------------------
     6. 키워드 포함률 계산 (서술형 채점 보조)
  ---------------------------------------------------------- */
  function calcKeywordInclusion(userText, keywords) {
    if (!keywords || keywords.length === 0) return null;
    if (!userText || !userText.trim()) {
      return {
        pct: 0, level: 'rate-low',
        msg: `핵심 키워드 0% 포함 (0/${keywords.length}) — 오답 가능성 높음`,
        matched: 0, total: keywords.length,
        matchedKws: [], missedKws: [...keywords],
      };
    }

    const norm    = s => s.toLowerCase().replace(/\s+/g, '').replace(/[.,!?:;]/g, '');
    const normUser = norm(userText);

    const matchedKws = [];
    const missedKws  = [];

    keywords.forEach(kw => {
      if (normUser.includes(norm(kw))) matchedKws.push(kw);
      else                              missedKws.push(kw);
    });

    const matched = matchedKws.length;
    const pct     = Math.round(matched / keywords.length * 100);

    let level, msg;
    if (pct >= 70) {
      level = 'rate-high';
      msg   = `핵심 키워드 ${pct}% 포함 (${matched}/${keywords.length}) — 정답 가능성 높음`;
    } else if (pct >= 40) {
      level = 'rate-medium';
      msg   = `핵심 키워드 ${pct}% 포함 (${matched}/${keywords.length}) — 부분 정답`;
    } else {
      level = 'rate-low';
      msg   = `핵심 키워드 ${pct}% 포함 (${matched}/${keywords.length}) — 오답 가능성 높음`;
    }

    return { pct, level, msg, matched, total: keywords.length, matchedKws, missedKws };
  }

  /* ----------------------------------------------------------
     7. 채점
  ---------------------------------------------------------- */

  /** 텍스트 정규화 (공백·구두점 제거, 소문자) */
  function normalize(s) {
    return (s || '').toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[.,!?:;()（）「」『』""'']/g, '');
  }

  /**
   * 나열형 채점 — 순서 무관
   * @param {string[]} userInputs    - 사용자가 입력한 값 배열 (빈칸 개수만큼)
   * @param {string[]} correctItems  - 정답 키워드 배열 (blankedKeywords)
   */
  function gradeListAnswer(userInputs, correctItems) {
    const remaining = [...correctItems];
    const results   = [];

    userInputs.forEach((input, i) => {
      const normInput = normalize(input);
      if (!normInput) {
        results.push({
          index: i, correct: false,
          userInput: input, expected: correctItems[i] || '',
        });
        return;
      }

      // 남은 정답 중 가장 잘 맞는 것 탐색
      let bestIdx = -1;
      let bestScore = -1;

      remaining.forEach((kw, ri) => {
        const normKw = normalize(kw);
        let score = 0;
        if (normInput === normKw) score = 3;
        else if (normInput.includes(normKw) || normKw.includes(normInput)) score = 2;
        else if (_partialMatch(normInput, normKw)) score = 1;
        if (score > bestScore) { bestScore = score; bestIdx = ri; }
      });

      if (bestScore > 0 && bestIdx !== -1) {
        results.push({
          index: i, correct: true,
          userInput: input, expected: remaining[bestIdx],
        });
        remaining.splice(bestIdx, 1);
      } else {
        results.push({
          index: i, correct: false,
          userInput: input, expected: correctItems[i] || '',
        });
      }
    });

    const correctCount = results.filter(r => r.correct).length;
    const score = userInputs.length > 0
      ? Math.round(correctCount / userInputs.length * 100) : 0;

    return { results, correctCount, total: userInputs.length, score };
  }

  /**
   * 단계형 채점 — 순서 있음
   * @param {string[]} userInputs - 사용자 입력 배열
   * @param {string[]} steps      - 정답 단계 배열 (blankedKeywords, 순서 유지)
   */
  function gradeStepAnswer(userInputs, steps) {
    const results = userInputs.map((input, i) => {
      const expected    = steps[i] || '';
      const normInput   = normalize(input);
      const normExpected = normalize(expected);
      const correct = normInput.length > 0 && (
        normInput === normExpected ||
        normInput.includes(normExpected) ||
        normExpected.includes(normInput)
      );
      return { index: i, correct, userInput: input, expected };
    });

    const correctCount = results.filter(r => r.correct).length;
    const score = userInputs.length > 0
      ? Math.round(correctCount / userInputs.length * 100) : 0;

    return { results, correctCount, total: userInputs.length, score };
  }

  /** 부분 일치 (2글자 이상 공통 접두/접미) */
  function _partialMatch(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return false;
    if (a.length > 2 && b.startsWith(a.slice(0, 2))) return true;
    if (b.length > 2 && a.startsWith(b.slice(0, 2))) return true;
    return false;
  }

  /* ----------------------------------------------------------
     8. 채점 결과 요약 (나열형·단계형 공통)
  ---------------------------------------------------------- */
  function isAutoGradePass(score, answerType) {
    // 나열형: 정답 기준 없음(점수대로), 단계형: 동일
    // 50% 이상이면 '정답 처리', 아니면 '오답 처리' 권장값 반환
    return score >= 50;
  }

  /* ----------------------------------------------------------
     공개 API
  ---------------------------------------------------------- */
  return {
    // 유형 판별
    detectAnswerType,
    getTypeName,

    // 키워드 추출
    extractKeywords,
    extractListItems,
    extractStepItems,
    extractDescriptiveKeywords,

    // 분석
    analyzeWithRules,

    // 빈칸
    generateBlanks,
    parseAnswerSegments,

    // 채점 보조
    calcKeywordInclusion,
    normalize,
    gradeListAnswer,
    gradeStepAnswer,
    isAutoGradePass,
  };

})();
