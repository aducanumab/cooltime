// ============================================================
//  Supabase Edge Function: 사진 → 음식 메뉴명 최대 4개 인식
//  (관리자의 Google AI Studio 키로 Gemma를 직접 호출하는 프록시)
//
//  배포: 대시보드 > Edge Functions > (기존 함수 열기) > 코드 전체 교체 > Deploy
//        * 함수 이름은 config.js 의 RECOGNIZE_FUNCTION 값과 일치해야 함 (현재 dynamic-service)
//  시크릿: Edge Functions > Secrets 에 아래 추가
//        GEMINI_API_KEY = AIza...            (필수, Google AI Studio 키 — 브라우저에 안 감)
//        GEMINI_MODEL   = gemma-4-31b-it     (선택, 클라이언트가 model 미지정 시 기본값)
//  * 클라이언트가 body.model 로 모델을 지정할 수 있고(안전목록: gemma-4*, gemini-*-flash),
//    모델 폴백(오류 시 다음 모델 전환)은 클라이언트가 순차 호출로 오케스트레이션한다.
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

// 서술형 답변에서 '완성된 한 문장'만 추출 (Gemma가 앞에 영어 사고과정을 붙일 때 대비)
function pickSentence(text: string): string {
  const t = (text || '').replace(/\r/g, '');
  // 1) 줄 단위: 불릿·번호·영어 라벨 제외
  const lines = t.split(/\n+/).map((s) => s.trim())
    .filter((l) =>
      /[가-힣]/.test(l) && l.length >= 8
      && !/^[-*#>]|^\d+[.)]/.test(l)
      && !/^[A-Za-z][A-Za-z ]*:/.test(l));
  let best = lines.find((l) => /kcal|칼로리|열량/i.test(l)) || lines[lines.length - 1];
  // 2) 줄에서 못 찾으면 전체를 문장 단위로 쪼개서 탐색
  if (!best) {
    const sents = t.split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim())
      .filter((s) => /[가-힣]/.test(s) && s.length >= 8);
    best = sents.find((s) => /kcal|칼로리|열량/i.test(s)) || sents[sents.length - 1];
  }
  best = best || '';
  if (best.length > 200) {
    const sents = best.split(/(?<=[.!?。])\s+/);
    best = sents.find((s) => /kcal|칼로리|열량/i.test(s)) || sents[0] || best;
  }
  return best.replace(/^["'*\-\s]+/, '').replace(/["'*\s]+$/, '').slice(0, 200);
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

    // 2) 입력 수신 (image: 사진 인식 / menu: 영양정보 / text: 연결 헬스체크)
    const { image, text: textQuery, menu, model: reqModel } = await req.json().catch(() => ({}));

    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) return json({ error: '서버에 GEMINI_API_KEY가 설정되지 않았습니다.' }, 500);
    // 클라이언트가 지정한 모델은 안전 목록(gemma-4*, gemini-*-flash)일 때만 허용 (비싼 모델 남용 방지)
    const allowed = (m: unknown): m is string => typeof m === 'string' && /^gemma-4|^gemini-[0-9.]+-flash/.test(m);
    const model = allowed(reqModel) ? reqModel : (Deno.env.get('GEMINI_MODEL') ?? 'gemma-4-31b-it');

    const genText = (prompt: string, cfg: Record<string, unknown> = {}) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024, ...cfg },
        }),
      });

    // 2-a) 영양정보 모드: 메뉴명 → 한 문장(메모용)
    //   JSON 강제 출력(responseSchema)으로 Gemma의 영어 사고과정을 억제.
    //   미지원(400)이면 넉넉한 토큰의 일반 모드 + 문장 추출로 폴백. 5xx/429는 재시도.
    if (!image && typeof menu === 'string' && menu.trim()) {
      const prompt =
        `"${menu.trim()}" 1인분의 대략적 영양정보와 건강상 추천 섭취 간격(쿨타임)을 ` +
        `한국어 한 문장으로 note 필드에 담아 JSON으로만 답하라. ` +
        `예시: {"note":"1인분 약 500kcal, 간장과 기름에 조린 헤비한 음식으로 2달에 한 번 권장."}`;
      const jsonCfg = {
        temperature: 0.2,
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { note: { type: 'STRING' } }, required: ['note'] },
      };
      // 모델당 빠르게 시도(모델 폴백은 클라이언트가 오케스트레이션). 스키마 미지원(400)만 일반 모드로.
      let r = await genText(prompt, jsonCfg);
      if (r.status === 400) r = await genText(prompt, { maxOutputTokens: 3072 });
      if (!r.ok) return json({ error: `gemini ${r.status}`, detail: (await r.text()).slice(0, 300), model }, 502);
      const d = await r.json();
      const raw = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      let note = '';
      try { note = String(extractJson(raw).note ?? '').trim(); } catch { note = pickSentence(raw); }
      if (!note) note = pickSentence(raw); // JSON.note가 비면 원문에서 재추출
      return json({ note, model, raw: raw.slice(0, 400) }, 200);
    }

    // 2-b) 텍스트 질의 모드: 모델 연결 점검용 (원문 그대로 반환)
    if (!image && textQuery && typeof textQuery === 'string') {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ parts: [{ text: textQuery }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
          }),
        },
      );
      if (!r.ok) return json({ error: `gemini ${r.status}`, detail: (await r.text()).slice(0, 300) }, 502);
      const d = await r.json();
      return json({ raw: d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '' }, 200);
    }

    if (!image || typeof image !== 'string') return json({ error: '이미지가 없습니다.' }, 400);
    const { mimeType, base64 } = splitDataUrl(image);

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

    // JSON 강제 모드(camelCase) → 미지원(400)이면 일반 모드. 모델 폴백은 클라이언트가 처리하므로 여기선 빠르게 실패.
    let r = await call({ temperature: 0, maxOutputTokens: 1024, responseMimeType: 'application/json' });
    if (r.status === 400) r = await call({ temperature: 0, maxOutputTokens: 1024 });
    if (!r.ok) return json({ error: `gemini ${r.status}`, detail: (await r.text()).slice(0, 300), model }, 502);

    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // JSON 우선, 실패 시 텍스트에서 관대하게 후보 추출 (Gemma가 서술형으로 답할 때 대비)
    let list: string[] = [];
    try {
      const parsed = extractJson(text);
      if (Array.isArray(parsed.candidates)) list = parsed.candidates.map((c: unknown) => String(c));
    } catch {
      // 폴백: 따옴표로 묶인 토큰 → 없으면 쉼표/줄바꿈 분리
      const quoted = [...text.matchAll(/"([^"]{1,20})"/g)].map((m) => m[1]);
      list = quoted.length ? quoted : text.split(/[\n,]+/).map((s) => s.trim());
    }
    // 서술형 답변 대비 정제: 앞 번호/불릿, 괄호 안 영어, 마크다운/따옴표 제거 → 순수 메뉴명
    const clean = (s: string) => s
      .replace(/^\s*[-*\d.)\s]+/, '')     // 앞 번호·불릿
      .replace(/\s*\([^)]*\)\s*/g, '')    // (Tteokbokki) 같은 괄호 병기
      .replace(/[*#`_\[\]"'‘’“”]/g, '') // 마크다운·따옴표
      .trim();
    const candidates = list
      .map(clean)
      .filter((c) => /[가-힣]/.test(c))              // 한글 있는 것만
      .filter((c) => c.length >= 2 && c.length <= 12) // 서술 문장 제외
      .filter((c) => !/^(menu|메뉴)\s*\d*$/i.test(c)) // 예시 에코 방어
      .filter((c, i, a) => a.indexOf(c) === i)        // 중복 제거
      .slice(0, 4);

    // 파싱 실패해도 200 + raw 로 진단 가능하게 (500 던지지 않음)
    return json({ candidates, name: candidates[0] ?? '', model, raw: text.slice(0, 300) }, 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
