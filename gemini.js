/* ============================================================
   gemini.js  —  Gemini API 연동 모듈
   - 문제 등록/수정 시 또는 수동 재분석 시 1회 호출
   - 학습 화면에서는 호출하지 않는다
   - API 실패 시 analysis.js 규칙 기반으로 자동 전환
============================================================ */

const GeminiAPI = (() => {

  const BASE_URL =
    'https://generativelanguage.googleapis.com/v1beta/models';

  /* ----------------------------------------------------------
     1. API 사용 가능 여부 확인
  ---------------------------------------------------------- */
  function isAvailable() {
    return !!Storage.getApiKey();
  }

  /* ----------------------------------------------------------
     2. 분석 프롬프트 구성
  ---------------------------------------------------------- */
  function buildPrompt(question, answer) {
    return `다음 시험 답안을 분석하여 JSON을 반환하라. JSON 외 텍스트 금지.

[문제] ${question}
[답안] ${answer}

[answerType]
- "step": → 기호 또는 단계/순서 구조
- "list": ①②③ 또는 줄바꿈 나열
- "descriptive": 그 외

[keywords] 최대15개
- 이론명·학자명·단계명·고유명사·핵심개념어
- 문장 전체 금지

[keyPoints] 최대10개
- 단어 또는 짧은 구절만

[blanks] 최대10개
- text: 답안 원문에 그대로 존재하는 단어/구절 (exact match)
- 30자 이하, 조사(의/가/을/를/은/는) 단독 금지
- 중복 금지, 문장 전체 금지
- importance: "high" 또는 "medium"

[structure] 10자 이내`;
  }

  /* ----------------------------------------------------------
     3. API 호출
     - responseMimeType + responseSchema 로 JSON 구조를 모델 레벨에서 강제
     - responseSchema 미지원 구형 모델은 자동 폴백 (schema 제거 후 재시도)
  ---------------------------------------------------------- */
  async function _callAPI(prompt, apiKey, model, timeoutMs = 30000) {
    const url        = `${BASE_URL}/${model}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    const generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          answerType: { type: 'string' },
          keywords:   { type: 'array', items: { type: 'string' }, maxItems: 15 },
          keyPoints:  { type: 'array', items: { type: 'string' }, maxItems: 10 },
          blanks: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                text:       { type: 'string' },
                importance: { type: 'string' },
              },
            },
          },
          structure: { type: 'string' },
        },
        required: ['answerType', 'keywords'],
      },
      temperature:     0.1,
      maxOutputTokens: 2048,
    };

    const makeBody = (cfg) => JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: cfg,
    });

    const doFetch = (bodyStr) => fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    bodyStr,
      signal:  controller.signal,
    });

    try {
      let res = await doFetch(makeBody(generationConfig));

      // responseSchema 미지원(400) 시 schema 없이 재시도
      if (res.status === 400) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error?.message || '';
        if (msg.includes('responseSchema') || msg.includes('response_schema')) {
          console.warn('[GeminiAPI] responseSchema 미지원 모델, schema 없이 재시도합니다.');
          const fallbackCfg = { ...generationConfig };
          delete fallbackCfg.responseSchema;
          res = await doFetch(makeBody(fallbackCfg));
        }
      }

      // 429 한도 초과: retryDelay 파싱 후 1회 자동 재시도
      if (res.status === 429) {
        const errBody = await res.json().catch(() => ({}));
        const details = errBody?.error?.details || [];
        const retryInfo = details.find(d => d.retryDelay);
        const delaySec  = retryInfo
          ? parseFloat(retryInfo.retryDelay) || 15
          : (() => {
              const m = (errBody?.error?.message || '').match(/retry in\s+([\d.]+)s/i);
              return m ? parseFloat(m[1]) : 15;
            })();
        console.warn(`[GeminiAPI] 429 한도 초과. ${delaySec}초 후 재시도합니다.`);
        await new Promise(r => setTimeout(r, delaySec * 1000));
        res = await doFetch(makeBody(generationConfig));
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${res.status}`);
      }

      return res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('API 요청 시간이 초과되었습니다 (30초).');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ----------------------------------------------------------
     4a. JSON 헬퍼: 균형 잡힌 { } 블록 추출
         - 첫 번째 { 부터 짝이 맞는 } 까지 반환
         - } 없이 잘린 경우 { 부터 끝까지 반환 (복구 대상)
  ---------------------------------------------------------- */
  function _extractJsonBlock(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc)                       { esc = false; continue; }
      if (ch === '\\' && inStr)      { esc = true;  continue; }
      if (ch === '"')                { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === '{') depth++;
        else if (ch === '}') { if (--depth === 0) return text.slice(start, i + 1); }
      }
    }
    return depth > 0 ? text.slice(start) : null; // 잘린 경우 start ~ 끝
  }

  /* ----------------------------------------------------------
     4b. JSON 헬퍼: 잘린 JSON 자동 복구
         1) 열린 채 끝난 문자열 제거
         2) 후행 쉼표 제거
         3) 미닫힌 [] {} 닫기
  ---------------------------------------------------------- */
  function _repairJson(text) {
    let s = text.trimEnd();

    // 열린 채 끝난 문자열 위치 추적
    let inStr = false, esc = false, openAt = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc)                  { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true;  continue; }
      if (ch === '"') {
        if (!inStr) { inStr = true;  openAt = i; }
        else        { inStr = false; openAt = -1; }
      }
    }
    if (inStr && openAt !== -1) {
      s = s.slice(0, openAt).trimEnd().replace(/,\s*$/, '');
    }

    // 후행 쉼표 제거
    s = s.trimEnd().replace(/,\s*$/, '');

    // 열린 괄호 집계
    inStr = false; esc = false;
    let braces = 0, brackets = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc)                  { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true;  continue; }
      if (ch === '"')           { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === '{')      braces++;
        else if (ch === '}') braces--;
        else if (ch === '[') brackets++;
        else if (ch === ']') brackets--;
      }
    }

    return s + ']'.repeat(Math.max(0, brackets)) + '}'.repeat(Math.max(0, braces));
  }

  /* ----------------------------------------------------------
     4c. 다중 전략 JSON 파싱
         전략 1: 직접 파싱 (responseSchema 정상 동작 시)
         전략 2: 마크다운 코드블록(```json```) 제거 후 파싱
         전략 3: 균형 { } 블록 추출 후 파싱
         전략 4: 추출 블록 자동 복구 후 파싱
  ---------------------------------------------------------- */
  function _tryParseStrategies(raw) {
    const text = raw.trim();

    // 전략 1
    try { return JSON.parse(text); } catch {}

    // 전략 2 — ```json ... ``` 또는 ``` ... ```
    const codeMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeMatch) {
      const inner = codeMatch[1].trim();
      try { return JSON.parse(inner); } catch {}
    }

    // 전략 3 — 균형 { } 블록
    const block = _extractJsonBlock(text);
    if (block) {
      try { return JSON.parse(block); } catch {}

      // 전략 4 — 자동 복구
      const repaired = _repairJson(block);
      if (repaired !== block) {
        console.debug('[GeminiAPI] 자동 복구 적용:', repaired.slice(0, 300));
        try { return JSON.parse(repaired); } catch {}
      }
    }

    return null;
  }

  /* ----------------------------------------------------------
     4. 응답 파싱 (메인)
  ---------------------------------------------------------- */
  function _parseResponse(apiResponse) {
    const raw          = apiResponse?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const finishReason = apiResponse?.candidates?.[0]?.finishReason ?? 'UNKNOWN';

    // 디버그 로그
    console.debug('[GeminiAPI] finishReason:', finishReason);
    console.debug('[GeminiAPI] 응답 원문 (최초 500자):', raw.slice(0, 500));

    if (!raw) {
      throw new Error(`API 응답 텍스트가 비어 있습니다. (finishReason: ${finishReason})`);
    }
    if (finishReason === 'MAX_TOKENS') {
      console.warn('[GeminiAPI] maxOutputTokens 한계로 응답이 잘렸습니다. 복구를 시도합니다.');
    }

    const parsed = _tryParseStrategies(raw);
    if (!parsed) {
      console.error('[GeminiAPI] 파싱 실패 — 응답 원문 전체:', raw);
      throw new Error('JSON 파싱 실패: ' + raw.slice(0, 200));
    }

    // 필수 필드 검증 및 기본값
    const answerType = ['list', 'step', 'descriptive'].includes(parsed.answerType)
      ? parsed.answerType : 'descriptive';

    const keywords  = (Array.isArray(parsed.keywords)  ? parsed.keywords.filter(Boolean)  : []).slice(0, 15);
    const keyPoints = (Array.isArray(parsed.keyPoints)  ? parsed.keyPoints.filter(Boolean) : keywords.slice()).slice(0, 10);
    const blanks    = (Array.isArray(parsed.blanks)
      ? parsed.blanks.filter(b => b && b.text && b.text.length <= 30)
      : keywords.filter(kw => kw.length <= 30).map(kw => ({ text: kw, importance: 'high' }))).slice(0, 10);
    const structure = typeof parsed.structure === 'string' ? parsed.structure : '';

    if (keywords.length === 0) {
      throw new Error('키워드 추출 결과가 비어 있습니다.');
    }

    return { answerType, keywords, keyPoints, blanks, structure };
  }

  /* ----------------------------------------------------------
     5. 메인: 문제 분석 (외부에서 호출하는 함수)
     분석 성공 시 analysis 객체 반환.
     실패 시 규칙 기반으로 자동 전환하여 반환.
     @returns {{ analysis, usedAI: boolean, error?: string }}
  ---------------------------------------------------------- */
  async function analyzeQuestion(question, answer) {
    const apiKey = Storage.getApiKey();
    const model  = Storage.getSettings().geminiModel || 'gemini-2.5-flash';

    if (!apiKey) {
      // API Key 없음 → 규칙 기반
      const analysis = Analyzer.analyzeWithRules(question, answer);
      return { analysis, usedAI: false };
    }

    try {
      const prompt      = buildPrompt(question, answer);
      const apiResponse = await _callAPI(prompt, apiKey, model);
      const parsed      = _parseResponse(apiResponse);

      const analysis = {
        method:     'ai',
        model,
        analyzedAt: new Date().toISOString(),
        ...parsed,
      };

      return { analysis, usedAI: true };

    } catch (err) {
      console.warn('[GeminiAPI] 분석 실패, 규칙 기반으로 전환:', err.message);
      const analysis = Analyzer.analyzeWithRules(question, answer);
      analysis.aiError = err.message; // 실패 이유 기록
      return { analysis, usedAI: false, error: err.message };
    }
  }

  /* ----------------------------------------------------------
     6. API Key 유효성 테스트
     짧은 프롬프트로 연결만 확인한다.
     @returns {{ ok: boolean, message: string }}
  ---------------------------------------------------------- */
  async function testApiKey(apiKey, model) {
    if (!apiKey || !apiKey.trim()) {
      return { ok: false, message: 'API Key를 입력하세요.' };
    }

    const testModel  = model || 'gemini-2.5-flash';
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 10000);

    try {
      const url = `${BASE_URL}/${testModel}:generateContent?key=${apiKey.trim()}`;
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: '안녕하세요. 응답 가능하면 "OK"라고만 답하세요.' }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        return { ok: true, message: `연결 성공 (${testModel})` };
      }

      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${res.status}`;

      if (res.status === 400) return { ok: false, message: `잘못된 요청: ${msg}` };
      if (res.status === 403) return { ok: false, message: 'API Key가 유효하지 않거나 권한이 없습니다.' };
      if (res.status === 429) return { ok: false, message: '요청 한도 초과. 잠시 후 다시 시도하세요.' };

      return { ok: false, message: msg };

    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, message: 'API 연결 시간이 초과되었습니다 (10초). 네트워크를 확인하세요.' };
      if (e.name === 'TypeError')  return { ok: false, message: '네트워크 오류. 인터넷 연결을 확인하세요.' };
      return { ok: false, message: e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ----------------------------------------------------------
     공개 API
  ---------------------------------------------------------- */
  return {
    isAvailable,
    analyzeQuestion,
    testApiKey,
    buildPrompt,     // 디버그/미리보기용
  };

})();
