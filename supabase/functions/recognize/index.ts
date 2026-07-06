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
  '사진 속 음식을 인식해 대표 메뉴명을 최대 4개까지 한국어로 추출한다. ' +
  '반드시 JSON 하나만 출력한다: {"candidates":["메뉴1","메뉴2"]}. ' +
  '각 항목은 짧은 메뉴명(예: 떡볶이, 김밥). 설명·문장·마크다운·코드블록 금지. ' +
  '음식이 안 보이면 {"candidates":[]}.';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

function extractJson(text: string): any {
  if (!text) throw new Error('빈 응답');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSON 없음');
  return JSON.parse(m[0]);
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

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: `${RECOGNIZE_SYS}\n\n이 사진을 분석해 JSON으로만 답하라.` },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          }],
        }),
      },
    );
    if (!r.ok) return json({ error: `gemini ${r.status}`, detail: (await r.text()).slice(0, 300) }, 502);

    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = extractJson(text);
    const candidates = (Array.isArray(parsed.candidates) ? parsed.candidates : [])
      .map((c: unknown) => String(c).trim())
      .filter(Boolean)
      .slice(0, 4);

    return json({ candidates, name: candidates[0] ?? '' }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
