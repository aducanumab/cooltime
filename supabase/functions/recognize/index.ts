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
//  * gemini-2.5 계열은 thinkingBudget:0 으로 'thinking'을 꺼 출력 잘림을 막는다(gemma엔 보내면 400이라 미전송).
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
  // 앞머리에 붙은 JSON 껍데기('{ "note": "' 등)를 먼저 벗겨낸다(한글 서술은 영향 없음)
  const t = (text || '').replace(/\r/g, '').replace(/^\s*\{?\s*"?[\w-]+"?\s*:\s*"?/, '');
  const notJson = (l: string) => !/^[{}[\]]/.test(l) && !/^"?[\w-]+"?\s*:/.test(l); // JSON 줄 배제
  // 1) 줄 단위: 불릿·번호·영어 라벨·JSON 조각 제외
  const lines = t.split(/\n+/).map((s) => s.trim())
    .filter((l) =>
      /[가-힣]/.test(l) && l.length >= 8
      && !/^[-*#>]|^\d+[.)]/.test(l)
      && !/^[A-Za-z][A-Za-z ]*:/.test(l)
      && notJson(l));
  let best = lines.find((l) => /kcal|칼로리|열량/i.test(l)) || lines[lines.length - 1];
  // 2) 줄에서 못 찾으면 전체를 문장 단위로 쪼개서 탐색
  if (!best) {
    const sents = t.split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim())
      .filter((s) => /[가-힣]/.test(s) && s.length >= 8 && notJson(s));
    best = sents.find((s) => /kcal|칼로리|열량/i.test(s)) || sents[sents.length - 1];
  }
  best = best || '';
  if (best.length > 200) {
    const sents = best.split(/(?<=[.!?。])\s+/);
    best = sents.find((s) => /kcal|칼로리|열량/i.test(s)) || sents[0] || best;
  }
  return best.replace(/^["'*\-\s{]+/, '').replace(/["'*\s}]+$/, '').slice(0, 200);
}

// 문자열이 JSON 잔재('{...' 또는 '"note":...')처럼 보이면 true → note로 내보내지 않는다
function looksJson(s: string): boolean {
  return /^\s*[{[]/.test(s) || /^\s*"?note"?\s*:/.test(s);
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

    // 2) 입력 수신 (image: 사진 인식 / menu: 영양정보)
    const { image, menu, model: reqModel } = await req.json().catch(() => ({}));

    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) return json({ error: '서버에 GEMINI_API_KEY가 설정되지 않았습니다.' }, 500);
    // 클라이언트가 지정한 모델은 안전 목록(gemma-4*, gemini-*-flash)일 때만 허용 (비싼 모델 남용 방지)
    const allowed = (m: unknown): m is string => typeof m === 'string' && /^gemma-4|^gemini-[0-9.]+-flash/.test(m);
    const model = allowed(reqModel) ? reqModel : (Deno.env.get('GEMINI_MODEL') ?? 'gemma-4-31b-it');
    // gemini-2.5 계열은 기본 'thinking'이 켜져 있어 maxOutputTokens를 사고에 소진 → 짧은 출력이 중간에 잘린다.
    //   thinkingBudget:0으로 끄면 토큰 전부가 실제 출력에 쓰인다.
    //   ※ gemma-* / gemini-2.0-* 에 이 필드를 보내면 400(요청 전체 거부)이므로 2.5에만 보낸다.
    const thinkOff = /^gemini-2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {};

    // 모든 Gemini/Gemma 호출의 단일 관문 — URL·헤더·thinkOff 병합을 한 곳에서 관리
    const callGemini = (parts: unknown[], cfg: Record<string, unknown> = {}) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { ...cfg, ...thinkOff },
        }),
      });
    const genText = (prompt: string, cfg: Record<string, unknown> = {}) =>
      callGemini([{ text: prompt }], { temperature: 0.3, maxOutputTokens: 1024, ...cfg });

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
        maxOutputTokens: 1024, // thinking 꺼도(thinkOff) 한 문장엔 넉넉 — 잘림 방지 여유
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { note: { type: 'STRING' } }, required: ['note'] },
      };
      // 모델당 빠르게 시도(모델 폴백은 클라이언트가 오케스트레이션). 스키마 미지원(400)만 일반 모드로.
      let r = await genText(prompt, jsonCfg);
      if (r.status === 400) r = await genText(prompt, { maxOutputTokens: 3072 });
      if (!r.ok) return json({ error: `gemini ${r.status}`, detail: (await r.text()).slice(0, 300), model }, 502);
      const d = await r.json();
      const cand0 = d?.candidates?.[0];
      const raw = cand0?.content?.parts?.[0]?.text ?? '';
      // 출력이 잘렸으면(MAX_TOKENS) 조각을 note로 쓰지 않는다 → 빈 note로 두면 클라이언트가 다음 모델로 폴백
      const truncated = cand0?.finishReason === 'MAX_TOKENS';
      let note = '';
      if (!truncated) {
        try {
          note = String(extractJson(raw).note ?? '').trim();
        } catch {
          // 완결 JSON이 아니면 부분 "note":"..." 라도 복구(닫는 따옴표 없어도 됨) → 그래도 없으면 문장 추출
          const m = /"note"\s*:\s*"((?:[^"\\]|\\.)*)"?/.exec(raw);
          note = m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim() : pickSentence(raw);
        }
      }
      if (looksJson(note)) note = ''; // JSON 잔재가 새어나오면 폐기(클라이언트 폴백 유도)
      return json({ note, model, raw: raw.slice(0, 400) }, 200);
    }

    if (!image || typeof image !== 'string') return json({ error: '이미지가 없습니다.' }, 400);
    const { mimeType, base64 } = splitDataUrl(image);

    const call = (generationConfig: Record<string, unknown>) =>
      callGemini([
        { inline_data: { mime_type: mimeType, data: base64 } }, // 이미지를 먼저
        { text: RECOGNIZE_SYS },
      ], generationConfig); // callGemini가 thinkOff 병합(gemini-2.5 후보 JSON 잘림 방지)

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
      .replace(/[*#`_\[\]{}"'‘’“”]/g, '') // 마크다운·따옴표·중괄호
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
