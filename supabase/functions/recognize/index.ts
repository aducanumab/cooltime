// ============================================================
//  Supabase Edge Function: 사진 → 음식 메뉴명 최대 4개 인식
//  (관리자의 Google AI Studio 키로 Gemma를 직접 호출하는 프록시)
//
//  배포: 대시보드 > Edge Functions > (기존 함수 열기) > 코드 전체 교체 > Deploy
//        * 함수 이름은 config.js 의 RECOGNIZE_FUNCTION 값과 일치해야 함 (현재 dynamic-service)
//  시크릿: Edge Functions > Secrets 에 아래 추가
//        GEMINI_API_KEY = AIza...            (필수, Google AI Studio 키 — 브라우저에 안 감)
//        GEMINI_MODEL   = gemma-4-31b-it     (선택, 기본값 동일)
//  * 로그인한 사용자만 호출 가능(getUser 검증). SUPABASE_URL / SUPABASE_ANON_KEY 는
//    플랫폼이 자동 주입하는 환경변수라 별도 설정 불필요.
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RECOGNIZE_SYS =
  '이미지에 보이는 음식이 무엇인지 판별하라. ' +
  '너의 전체 출력은 유효한 JSON 객체 하나여야 한다. 키는 candidates 하나뿐이고, ' +
  '값은 이미지에 실제로 보이는 음식의 한국어 이름 문자열 배열이다(최대 4개, 가능성 높은 순). ' +
  '분석 과정, 설명 문장, 불릿, 마크다운, 영어 서술은 출력하지 마라. 출력의 첫 글자는 여는 중괄호여야 한다. ' +
  '음식이 안 보이면 candidates를 빈 배열로 하라.';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

// 첫 번째 '완전한' JSON 객체만 추출 (Gemma가 JSON 뒤에 군더더기를 붙여도 안전)
function extractJson(text: string): any {
  if (!text) throw new Error('빈 응답');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('JSON 없음');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  throw new Error('JSON 없음');
}

// dataURL → { mimeType, base64 }
function splitDataUrl(dataUrl: string) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl ?? '');
  if (!m) throw new Error('이미지 형식 오류 (dataURL 아님)');
  return { mimeType: m[1], base64: m[2] };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  try {
    // 1) 로그인 사용자 확인 (관리자 키 남용 방지)
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: '로그인이 필요합니다.' }, 401);

    // 2) 이미지 수신
    const { image } = await req.json().catch(() => ({}));
    if (!image || typeof image !== 'string') return json({ error: '이미지가 없습니다.' }, 400);
    const { mimeType, base64 } = splitDataUrl(image);

    // 3) 관리자 키로 Google AI Studio(Gemma) 직접 호출
    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) return json({ error: '서버에 GEMINI_API_KEY가 설정되지 않았습니다.' }, 500);
    const model = Deno.env.get('GEMINI_MODEL') ?? 'gemma-4-31b-it';

    const call = (generationConfig: Record<string, unknown>) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: base64 } }, // 이미지를 먼저
              { text: RECOGNIZE_SYS },
            ],
          }],
          generationConfig,
        }),
      });

    // 1차: JSON 강제 모드 → 모델이 미지원(400)이면 일반 모드로 폴백
    let r = await call({ temperature: 0, maxOutputTokens: 512, response_mime_type: 'application/json' });
    if (r.status === 400) {
      r = await call({ temperature: 0, maxOutputTokens: 512 });
    }
    if (!r.ok) return json({ error: `gemini ${r.status}`, detail: (await r.text()).slice(0, 300) }, 502);

    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = extractJson(text);
    const candidates = (Array.isArray(parsed.candidates) ? parsed.candidates : [])
      .map((c: unknown) => String(c).trim())
      .filter((c: string) => /[가-힣A-Za-z]/.test(c)) // 글자 없는 자리표시자("...") 제거
      .filter((c: string) => !/^(menu|메뉴)\s*\d*$/i.test(c)) // 예시 에코 방어
      .slice(0, 4);

    // raw: 모델 원문 일부(디버깅용 — 클라이언트는 무시해도 됨)
    return json({ candidates, name: candidates[0] ?? '', raw: text.slice(0, 200) }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
