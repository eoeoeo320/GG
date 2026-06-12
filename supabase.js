/* ============================================================
   supabase.js — 클라우드 동기화 모듈
   PC ↔ 모바일 자동 동기화 (Supabase 무료 플랜)

   [설정 방법]
   1. SUPABASE_URL, SUPABASE_KEY 를 아래에 직접 입력
   2. USER_ID 는 PC·모바일 모두 동일하게 유지 (동기화 키)
   3. Supabase 대시보드 → SQL Editor 에서 아래 SQL 실행:

   ──────────────────────────────────────────────────────────
   CREATE TABLE sync_data (
     user_id       TEXT PRIMARY KEY,
     questions     JSONB DEFAULT '[]',
     records       JSONB DEFAULT '{}',
     wrong_notes   JSONB DEFAULT '[]',
     settings      JSONB DEFAULT '{}',
     subject_colors JSONB DEFAULT '{}',
     updated_at    TIMESTAMPTZ DEFAULT NOW()
   );
   ALTER TABLE sync_data ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "allow_all" ON sync_data
     FOR ALL USING (true) WITH CHECK (true);
   ──────────────────────────────────────────────────────────
============================================================ */

const SupabaseSync = (() => {

  // ================================================================
  // ⚠️  아래 세 값을 본인 Supabase 프로젝트 설정으로 교체하세요
  // ================================================================
  const SUPABASE_URL = 'https://tvfarhfeyjpumgqxrerf.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2ZmFyaGZleWpwdW1ncXhyZXJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyMjE2NTMsImV4cCI6MjA5Njc5NzY1M30.oLeBGj7-AqGynxzWfPVG-iHV7_TKQ0n72kw4tRuJj5I';
  const USER_ID      = 'exam-user-01';  // PC·모바일에서 반드시 동일해야 동기화됨
  // ================================================================

  const TABLE  = 'sync_data';
  const TS_KEY = 'exam_sync_ts';  // 마지막 동기화 시각 (localStorage 저장)

  let _db    = null;
  let _timer = null;

  /* ----------------------------------------------------------
     내부 헬퍼
  ---------------------------------------------------------- */
  function _initDb() {
    if (_db) return _db;
    if (typeof supabase === 'undefined') {
      console.warn('[Supabase] 라이브러리가 로드되지 않았습니다.');
      return null;
    }
    _db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return _db;
  }

  function _getLocalTs() {
    return parseInt(localStorage.getItem(TS_KEY) || '0', 10);
  }

  function _setLocalTs(isoOrMs) {
    const ms = typeof isoOrMs === 'string'
      ? new Date(isoOrMs).getTime()
      : isoOrMs;
    localStorage.setItem(TS_KEY, ms.toString());
  }

  /* ----------------------------------------------------------
     공개 API
  ---------------------------------------------------------- */

  /** Supabase URL/KEY 가 입력됐는지 확인 */
  function isConfigured() {
    return !SUPABASE_URL.includes('YOUR_PROJECT_ID');
  }

  /** 현재 네트워크 온라인 여부 */
  function isOnline() {
    return navigator.onLine;
  }

  /** localStorage → Supabase 업로드 */
  async function push() {
    if (!isConfigured() || !isOnline()) return false;
    const db = _initDb();
    if (!db) return false;

    try {
      const now = new Date().toISOString();
      const { error } = await db.from(TABLE).upsert({
        user_id:        USER_ID,
        questions:      Storage.getQuestions(),
        records:        Storage.getRecords(),
        wrong_notes:    Storage.getWrongNotes(),
        settings:       Storage.getSettings(),
        subject_colors: Storage.getSubjectColors(),
        updated_at:     now,
      }, { onConflict: 'user_id' });

      if (error) throw error;
      _setLocalTs(now);
      console.log('[Supabase] ↑ push 완료');
      return true;
    } catch (e) {
      console.error('[Supabase] push 실패:', e.message);
      return false;
    }
  }

  /**
   * Supabase → localStorage 다운로드
   * - 원격이 더 최신일 때만 덮어씀
   * - 원격 데이터 없으면 현재 로컬을 push
   * @returns {boolean} 데이터가 실제로 업데이트됐으면 true
   */
  async function pull() {
    if (!isConfigured() || !isOnline()) return false;
    const db = _initDb();
    if (!db) return false;

    try {
      const { data, error } = await db
        .from(TABLE)
        .select('*')
        .eq('user_id', USER_ID)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        // 원격 데이터 없음 → 로컬 데이터를 초기 업로드
        await push();
        return false;
      }

      const remoteTs = new Date(data.updated_at).getTime();
      const localTs  = _getLocalTs();

      if (remoteTs <= localTs) {
        console.log('[Supabase] 로컬이 최신 상태 — pull 생략');
        return false;
      }

      // 원격이 더 최신 → import (sync 루프 방지 위해 Storage.importFromCloud 사용)
      Storage.importFromCloud({
        questions:      data.questions,
        records:        data.records,
        wrong_notes:    data.wrong_notes,
        settings:       data.settings,
        subject_colors: data.subject_colors,
      });
      _setLocalTs(data.updated_at);
      console.log('[Supabase] ↓ pull 완료 — 원격 데이터 적용');
      return true;

    } catch (e) {
      console.error('[Supabase] pull 실패:', e.message);
      return false;
    }
  }

  /**
   * 데이터 변경 후 2초 디바운스로 push 예약
   * storage.js의 _set 에서 자동 호출됨
   */
  function schedulePush() {
    clearTimeout(_timer);
    _timer = setTimeout(push, 2000);
  }

  /**
   * 앱 시작 시 1회 호출
   * - pull 로 원격 최신 데이터 수신
   * - 온라인 복귀 이벤트 리스너 등록
   * @returns {boolean} pull 로 데이터가 업데이트됐으면 true
   */
  async function init() {
    if (!isConfigured()) {
      console.log('[Supabase] 미설정 — 로컬 전용으로 실행됩니다.');
      console.log('[Supabase] supabase.js 상단의 SUPABASE_URL / SUPABASE_KEY / USER_ID 를 입력하세요.');
      return false;
    }

    window.addEventListener('online', () => {
      console.log('[Supabase] 온라인 복귀 — 자동 push 실행');
      push();
    });

    return await pull();
  }

  return { isConfigured, isOnline, push, pull, schedulePush, init };

})();
