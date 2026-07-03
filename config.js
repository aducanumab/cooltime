// ============================================================
//  Supabase 연결 정보
//  (Supabase 대시보드 > Settings > Data API / API Keys)
//
//  * anon(public) key는 RLS(행 단위 보안)가 켜진 상태에서
//    공개되어도 안전하도록 설계된 키입니다. 커밋해도 됩니다.
//  * 절대 service_role 키를 여기에 넣지 마세요!
// ============================================================
window.COOLTIME_CONFIG = {
  SUPABASE_URL: 'https://rrrixxscevoaifckicrs.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJycml4eHNjZXZvYWlmY2tpY3JzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4ODgxMjEsImV4cCI6MjA5ODQ2NDEyMX0.hobVCO1v7UePFt350X0OQQ_m_nL-hnNK4aA43vlZiBw',
  // 사진 자동 인식 Edge Function 이름 (대시보드에서 배포한 함수명과 일치해야 함)
  RECOGNIZE_FUNCTION: 'dynamic-service',
};
