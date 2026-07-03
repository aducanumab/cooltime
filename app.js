'use strict';

/* =========================================================================
 *  쿨타임 트래커 v2 — 계정(Supabase Auth) + 클라우드 DB(Postgres/RLS)
 *  - 로그인 필수. 기록·메뉴는 본인 계정에만 저장(행 단위 보안).
 *  - 비밀번호는 우리 DB에 없음 — Supabase Auth가 해시로 관리.
 *  - AI 영양분석: 공급자 무관 어댑터 (기본 = 무료 데모 mock).
 *    LLM 키/설정은 이 브라우저(localStorage)에만 저장, 서버 전송 없음.
 * ======================================================================= */

/* ---------- Supabase 클라이언트 ---------- */
const CFG = window.COOLTIME_CONFIG || {};
const CONFIG_READY = !!(
  CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY &&
  !/YOUR-PROJECT|YOUR-ANON-KEY/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY)
);
const sb = CONFIG_READY ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

/* ---------- 로컬 저장 (기기 전용 항목만) ---------- */
const LS = {
  llm: 'cooldown.llm',                    // LLM 공급자/키/모델 — 기기 전용
  lastSeen: 'cooldown.lastSeenAt',        // 인앱 '새로 완료' 판단 기준(기기별)
  migrateDismissed: 'cooldown.migrateDismissed',
  legacyMenus: 'cooldown.menus',          // v1(localStorage) 데이터 — 이관 대상
  legacyRecords: 'cooldown.records',
  legacySettings: 'cooldown.settings',
};

function loadJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// LLM 설정 (v1 settings에서 1회 승계)
let llm = loadJSON(LS.llm, null);
if (!llm) {
  const legacy = loadJSON(LS.legacySettings, {});
  llm = {
    provider: legacy.llmProvider || 'mock',
    recognizer: 'mock',
    keys: Object.assign({ claude: '', openai: '', gemini: '' }, legacy.keys || {}),
    models: Object.assign(
      { claude: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini', gemini: 'gemini-2.0-flash' },
      legacy.models || {}
    ),
  };
  saveJSON(LS.llm, llm);
}
if (llm && !llm.recognizer) llm.recognizer = 'mock'; // 기존 사용자 backfill
function saveLlm() { saveJSON(LS.llm, llm); }

/* ---------- 앱 상태 (클라우드 캐시) ---------- */
let currentUser = null;   // Supabase user
let profile = null;       // profiles 행
let menus = [];           // [{id, name, cooldownDays, createdAt}]
let records = [];         // [{id, menuId, name, date, note, nutrition, createdAt}]
let newlyReady = new Set(); // 이번 세션에 '새로 완료'된 menuId
let loadedForUser = null;

/* ---------- 유틸 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const norm = (s) => String(s).trim().toLowerCase();

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayStr() { return ymd(new Date()); }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); } // 로컬 자정
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function defaultCooldown() { return profile ? profile.default_cooldown_days : 30; }

/* ---------- 메뉴 헬퍼 ---------- */
function findMenuByName(name) { return menus.find((m) => norm(m.name) === norm(name)); }
function getMenu(id) { return menus.find((m) => m.id === id); }

/* ---------- 쿨타임 계산 (v1과 동일) ---------- */
function menuStatus(menu) {
  const recs = records.filter((r) => r.menuId === menu.id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const last = recs[0];
  if (!last) return { menu, last: null, count: 0, available: true, daysRemaining: 0, progress: 0 };

  const lastDate = parseDate(last.date);
  const today = parseDate(todayStr());
  const elapsed = Math.max(0, daysBetween(lastDate, today));
  const cd = Number(menu.cooldownDays) || 0;
  const remaining = cd - elapsed;
  const nextDate = addDays(lastDate, cd);
  return {
    menu, last, count: recs.length, lastDate, nextDate,
    elapsed, available: remaining <= 0,
    daysRemaining: Math.max(0, remaining),
    progress: cd > 0 ? Math.max(0, Math.min(1, elapsed / cd)) : 1,
  };
}

/* =========================================================================
 *  store — 클라우드 데이터 계층 (Supabase CRUD + 메모리 캐시)
 * ======================================================================= */
const mapMenu = (row) => ({ id: row.id, name: row.name, cooldownDays: row.cooldown_days, createdAt: row.created_at });
function mapRecord(row) {
  const m = getMenu(row.menu_id);
  return {
    id: row.id, menuId: row.menu_id,
    name: m ? m.name : '(삭제된 메뉴)',
    date: row.eaten_on, note: row.note || '',
    nutrition: row.nutrition || null,
    createdAt: Date.parse(row.created_at) || 0,
  };
}

const store = {
  async loadAll() {
    const [mRes, rRes] = await Promise.all([
      sb.from('menus').select('*').order('created_at'),
      sb.from('records').select('*').order('eaten_on', { ascending: false }),
    ]);
    if (mRes.error) throw mRes.error;
    if (rRes.error) throw rRes.error;

    let pRes = await sb.from('profiles').select('*').single();
    if (pRes.error && pRes.error.code === 'PGRST116') {
      // 트리거 이전 가입 등 예외 대비: 프로필 없으면 생성
      pRes = await sb.from('profiles').insert({ id: currentUser.id }).select().single();
    }
    if (pRes.error) throw pRes.error;

    profile = pRes.data;
    menus = mRes.data.map(mapMenu);
    records = rRes.data.map(mapRecord);
  },

  async upsertMenu(name, cooldownDays) {
    const existing = findMenuByName(name);
    if (existing) {
      if (cooldownDays != null && cooldownDays !== existing.cooldownDays) {
        await this.updateMenuCooldown(existing.id, cooldownDays);
      }
      return existing;
    }
    const row = { name: name.trim(), cooldown_days: cooldownDays ?? defaultCooldown() };
    let { data, error } = await sb.from('menus').insert(row).select().single();
    if (error && error.code === '23505') {
      // 동시성으로 이미 생성된 경우: 다시 조회
      const all = await sb.from('menus').select('*');
      if (all.error) throw all.error;
      data = all.data.find((r) => norm(r.name) === norm(row.name));
      error = data ? null : error;
    }
    if (error) throw error;
    const m = mapMenu(data);
    menus.push(m);
    return m;
  },

  async updateMenuCooldown(id, days) {
    const { error } = await sb.from('menus').update({ cooldown_days: days }).eq('id', id);
    if (error) throw error;
    const m = getMenu(id);
    if (m) m.cooldownDays = days;
  },

  async deleteMenu(id) {
    const { error } = await sb.from('menus').delete().eq('id', id); // records는 cascade
    if (error) throw error;
    menus = menus.filter((x) => x.id !== id);
    records = records.filter((r) => r.menuId !== id);
  },

  async addRecord({ menuId, date, note, nutrition }) {
    const { data, error } = await sb.from('records')
      .insert({ menu_id: menuId, eaten_on: date, note: note || null, nutrition: nutrition || null })
      .select().single();
    if (error) throw error;
    const rec = mapRecord(data);
    records.push(rec);
    return rec;
  },

  async deleteRecord(id) {
    const { error } = await sb.from('records').delete().eq('id', id);
    if (error) throw error;
    records = records.filter((r) => r.id !== id);
  },

  async deleteAllData() {
    const { error } = await sb.from('menus').delete().not('id', 'is', null); // 본인 것만(RLS)
    if (error) throw error;
    menus = []; records = [];
  },

  async updateProfile(patch) {
    const { data, error } = await sb.from('profiles').update(patch).eq('id', currentUser.id).select().single();
    if (error) throw error;
    profile = data;
  },
};

/* =========================================================================
 *  AI 영양분석 — 공급자 무관 어댑터 (v1과 동일 구조, 설정만 llm.*)
 *  반환: { calories, carbs, protein, fat, sodium, healthNote, suggestedCooldownDays }
 * ======================================================================= */
const NUTRITION_SYS =
  '너는 음식 영양 분석기다. 사용자가 준 음식의 1인분 기준 대략적 영양정보를 JSON으로만 답하라. ' +
  '키: calories(kcal, 숫자), carbs(g), protein(g), fat(g), sodium(mg), ' +
  'healthNote(한국어 한 문장 건강 코멘트), suggestedCooldownDays(건강상 권장 섭취 간격 일수, 숫자). ' +
  '모르면 합리적 추정치를 써라. JSON 외의 어떤 텍스트도 출력하지 마라.';
const nutritionUserMsg = (name) => `음식: ${name}`;

function extractJson(text) {
  if (!text) throw new Error('빈 응답');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSON을 찾지 못함: ' + text.slice(0, 120));
  return JSON.parse(m[0]);
}
function normalizeNutrition(o) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    calories: num(o.calories),
    carbs: num(o.carbs),
    protein: num(o.protein),
    fat: num(o.fat),
    sodium: num(o.sodium),
    healthNote: o.healthNote ? String(o.healthNote) : '',
    suggestedCooldownDays: o.suggestedCooldownDays != null ? num(o.suggestedCooldownDays) : null,
  };
}

const PROVIDERS = {
  /* ---- 무료 데모: 네트워크 호출 없음, 로컬 추정 ---- */
  mock: {
    label: '데모(무료·로컬)',
    needsKey: false,
    async analyze(name) {
      await sleep(450);
      return normalizeNutrition(mockNutrition(name));
    },
  },

  /* ---- Claude (Anthropic Messages API) ---- */
  claude: {
    label: 'Claude',
    needsKey: true,
    async analyze(name) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': llm.keys.claude,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: llm.models.claude,
          max_tokens: 300,
          system: NUTRITION_SYS,
          messages: [{ role: 'user', content: nutritionUserMsg(name) }],
        }),
      });
      if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return normalizeNutrition(extractJson(data.content?.[0]?.text));
    },
  },

  /* ---- OpenAI (Chat Completions) ---- */
  openai: {
    label: 'OpenAI',
    needsKey: true,
    async analyze(name) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.keys.openai}` },
        body: JSON.stringify({
          model: llm.models.openai,
          messages: [
            { role: 'system', content: NUTRITION_SYS },
            { role: 'user', content: nutritionUserMsg(name) },
          ],
          response_format: { type: 'json_object' },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return normalizeNutrition(extractJson(data.choices?.[0]?.message?.content));
    },
  },

  /* ---- Google Gemini (generateContent) ---- */
  gemini: {
    label: 'Gemini',
    needsKey: true,
    async analyze(name) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${llm.models.gemini}:generateContent?key=${encodeURIComponent(llm.keys.gemini)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: `${NUTRITION_SYS}\n\n${nutritionUserMsg(name)}` }] }] }),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return normalizeNutrition(extractJson(data.candidates?.[0]?.content?.parts?.[0]?.text));
    },
  },
};

async function analyzeNutrition(name) {
  const provider = PROVIDERS[llm.provider] || PROVIDERS.mock;
  if (provider.needsKey && !llm.keys[llm.provider]) {
    throw new Error(`${provider.label} API 키가 설정되지 않았습니다. (관리 > 설정)`);
  }
  return provider.analyze(name);
}

/* ---- 데모용 로컬 영양 추정 ---- */
const MOCK_DB = {
  '떡볶이': { calories: 480, carbs: 92, protein: 9, fat: 8, sodium: 1300, healthNote: '탄수화물·나트륨이 높아 자주 먹기엔 부담돼요.', suggestedCooldownDays: 14 },
  '라면': { calories: 500, carbs: 73, protein: 10, fat: 17, sodium: 1800, healthNote: '나트륨이 매우 높습니다. 국물은 남기는 게 좋아요.', suggestedCooldownDays: 10 },
  '치킨': { calories: 800, carbs: 30, protein: 55, fat: 50, sodium: 1500, healthNote: '단백질은 풍부하지만 지방·열량이 높아요.', suggestedCooldownDays: 10 },
  '피자': { calories: 700, carbs: 80, protein: 28, fat: 30, sodium: 1400, healthNote: '한 판은 칼로리 폭탄, 적당히 즐기세요.', suggestedCooldownDays: 14 },
  '삼겹살': { calories: 650, carbs: 2, protein: 32, fat: 56, sodium: 600, healthNote: '포화지방이 많으니 채소와 곁들이세요.', suggestedCooldownDays: 7 },
  '햄버거': { calories: 600, carbs: 45, protein: 28, fat: 32, sodium: 1100, healthNote: '세트로 먹으면 열량이 크게 늘어요.', suggestedCooldownDays: 10 },
  '마라탕': { calories: 550, carbs: 60, protein: 25, fat: 22, sodium: 2000, healthNote: '나트륨·기름이 많은 편이에요.', suggestedCooldownDays: 14 },
  '곱창': { calories: 700, carbs: 10, protein: 30, fat: 60, sodium: 900, healthNote: '콜레스테롤·지방이 높습니다.', suggestedCooldownDays: 21 },
  '케이크': { calories: 400, carbs: 50, protein: 5, fat: 20, sodium: 250, healthNote: '당류가 높아요. 가끔만!', suggestedCooldownDays: 14 },
  '아이스크림': { calories: 250, carbs: 30, protein: 4, fat: 14, sodium: 100, healthNote: '당류와 포화지방에 주의하세요.', suggestedCooldownDays: 7 },
  '콜라': { calories: 150, carbs: 39, protein: 0, fat: 0, sodium: 15, healthNote: '액상과당 덩어리예요. 물로 바꿔보는 건 어때요?', suggestedCooldownDays: 3 },
  '커피': { calories: 50, carbs: 8, protein: 1, fat: 1, sodium: 40, healthNote: '카페인 과다는 수면에 영향을 줄 수 있어요.', suggestedCooldownDays: 1 },
};
function mockNutrition(name) {
  const key = Object.keys(MOCK_DB).find((k) => norm(name).includes(norm(k)));
  if (key) return MOCK_DB[key];
  const seed = norm(name).length;
  return {
    calories: 350 + (seed % 5) * 60,
    carbs: 40 + (seed % 4) * 8,
    protein: 12 + (seed % 3) * 4,
    fat: 12 + (seed % 4) * 5,
    sodium: 700 + (seed % 6) * 120,
    healthNote: '데모 추정치예요. 정확한 값은 AI 공급자를 연결하면 채워집니다.',
    suggestedCooldownDays: defaultCooldown(),
  };
}

/* =========================================================================
 *  사진 인식 — 공급자 무관 어댑터 (PROVIDERS/analyzeNutrition과 동형)
 *  recognizeMenu(dataUrl) 하나만 호출하면 설정된 인식 공급자가 처리.
 *  - mock: 무료·로컬 데모
 *  - tesseract: 기기 내 OCR (메뉴판/영수증 글자). 키 불필요, 최초 로딩 수 MB
 *  - claude/openai/gemini: 비전 (음식 접시 인식). 본인 키 + 호출당 과금 + 사진 외부 전송
 *  반환(정규화): { name, candidates[], confidence, rawText }
 * ======================================================================= */
const RECOGNIZE_SYS =
  '너는 사진 속 음식(또는 메뉴판·영수증의 메뉴 항목)을 인식하는 도우미다. ' +
  '사진에서 먹었을 법한 대표 메뉴명을 한국어로 추정하라. JSON으로만 답하라. ' +
  '키: name(가장 가능성 높은 메뉴명 하나, 문자열), candidates(가능성 있는 메뉴명 배열, 최대 5개), confidence(0~1 숫자). ' +
  '음식/메뉴가 안 보이면 name은 빈 문자열. JSON 외 텍스트 금지.';

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('이미지 형식 오류');
  return { mediaType: m[1], base64: m[2] };
}
function normalizeRecognition(o) {
  o = o || {};
  const conf = Number(o.confidence);
  return {
    name: o.name ? String(o.name).trim() : '',
    candidates: Array.isArray(o.candidates) ? o.candidates.map((c) => String(c).trim()).filter(Boolean).slice(0, 6) : [],
    confidence: Number.isFinite(conf) ? conf : null,
    rawText: o.rawText ? String(o.rawText) : '',
  };
}
// OCR 원문에서 메뉴명 후보 뽑기 (가격/숫자/기호 줄 제거)
function ocrCandidates(text) {
  return [...new Set(
    (text || '').split(/\n+/)
      .map((s) => s.replace(/[0-9,.\-₩:()\/]+/g, ' ').trim())
      .filter((s) => /[가-힣]/.test(s) && s.length >= 2)
  )].slice(0, 6);
}

// 이미지 리사이즈·압축 → base64 dataURL (처리속도↑, 비전 비용↓)
function fileToResizedDataUrl(file, maxEdge = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 열 수 없어요 (지원하지 않는 형식일 수 있음)')); };
    img.src = url;
  });
}

// tesseract.js 지연 로드 (tesseract 선택 시에만 다운로드)
let _tessLoading;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!_tessLoading) {
    _tessLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('tesseract.js 로드 실패 (네트워크 확인)'));
      document.head.appendChild(s);
    });
  }
  return _tessLoading;
}

const RECOGNIZERS = {
  mock: {
    label: '데모(무료·로컬)', needsKey: false,
    async recognize() {
      await sleep(500);
      const keys = Object.keys(MOCK_DB);
      return normalizeRecognition({ name: keys[0], candidates: keys.slice(0, 4), confidence: 0.5 });
    },
  },

  tesseract: {
    label: '기기 내 OCR', needsKey: false,
    async recognize(dataUrl) {
      await loadTesseract();
      const hint = $('#photo-hint');
      const { data } = await window.Tesseract.recognize(dataUrl, 'kor+eng', {
        logger: (m) => { if (hint && m && m.progress != null) hint.textContent = `OCR ${Math.round(m.progress * 100)}%…`; },
      });
      const text = data.text || '';
      const candidates = ocrCandidates(text);
      return normalizeRecognition({ name: candidates[0] || '', candidates, confidence: (data.confidence || 0) / 100, rawText: text });
    },
  },

  claude: {
    label: 'Claude 비전', needsKey: true,
    async recognize(dataUrl) {
      const { mediaType, base64 } = splitDataUrl(dataUrl);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': llm.keys.claude,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: llm.models.claude,
          max_tokens: 200,
          system: RECOGNIZE_SYS,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: '이 사진을 분석해 JSON으로만 답하라.' },
          ] }],
        }),
      });
      if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
      const d = await res.json();
      return normalizeRecognition(extractJson(d.content?.[0]?.text));
    },
  },

  openai: {
    label: 'OpenAI 비전', needsKey: true,
    async recognize(dataUrl) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.keys.openai}` },
        body: JSON.stringify({
          model: llm.models.openai,
          messages: [
            { role: 'system', content: RECOGNIZE_SYS },
            { role: 'user', content: [
              { type: 'text', text: '이 사진을 분석해 JSON으로만 답하라.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ] },
          ],
          response_format: { type: 'json_object' },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      const d = await res.json();
      return normalizeRecognition(extractJson(d.choices?.[0]?.message?.content));
    },
  },

  gemini: {
    label: 'Gemini 비전', needsKey: true,
    async recognize(dataUrl) {
      const { mediaType, base64 } = splitDataUrl(dataUrl);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${llm.models.gemini}:generateContent?key=${encodeURIComponent(llm.keys.gemini)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [
          { text: `${RECOGNIZE_SYS}\n\n이 사진을 분석해 JSON으로만 답하라.` },
          { inline_data: { mime_type: mediaType, data: base64 } },
        ] }] }),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      const d = await res.json();
      return normalizeRecognition(extractJson(d.candidates?.[0]?.content?.parts?.[0]?.text));
    },
  },
};

async function recognizeMenu(dataUrl) {
  const rec = RECOGNIZERS[llm.recognizer] || RECOGNIZERS.mock;
  if (rec.needsKey && !llm.keys[llm.recognizer]) {
    throw new Error(`${rec.label} API 키가 설정되지 않았습니다. (관리 > 설정 > 사진 인식 공급자)`);
  }
  return rec.recognize(dataUrl);
}

/* =========================================================================
 *  인증 — 화면 게이트 & 플로우
 * ======================================================================= */
function setGate(loggedIn) {
  $('#app-view').hidden = !loggedIn;
  $('#auth-view').hidden = loggedIn;
}
function showAuthScreen(name) {
  $$('#auth-view [data-auth-view]').forEach((el) => { el.hidden = el.dataset.authView !== name; });
  $$('#auth-view .form-error').forEach((el) => { el.hidden = true; });
}
function showFormError(sel, msg) {
  const el = $(sel);
  el.textContent = msg;
  el.hidden = false;
}
function showNotice(title, body) {
  $('#notice-title').textContent = title;
  $('#notice-body').textContent = body;
  showAuthScreen('notice');
}
function authMsg(err) {
  const m = (err && err.message) || '';
  if (/invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (/email not confirmed/i.test(m)) return '이메일 인증이 아직 안 됐어요. 받은편지함(스팸함 포함)의 인증 링크를 눌러주세요.';
  if (/already registered/i.test(m)) return '이미 가입된 이메일입니다.';
  if (/rate limit|too many/i.test(m)) return '요청이 너무 잦아요. 잠시 후 다시 시도하세요. (무료 메일 발송 제한)';
  if (/password.*(short|least|character)/i.test(m)) return '비밀번호가 너무 짧습니다. 8자 이상으로 해주세요.';
  if (/failed to fetch|network/i.test(m)) return '네트워크 오류 — 인터넷 연결 또는 Supabase 프로젝트 상태(일시정지 여부)를 확인하세요.';
  return m || '알 수 없는 오류가 발생했어요.';
}

/* ---------- 미리보기(게스트) 모드 ---------- */
let guestMode = false;

function togglePreviewBanner(show) {
  const b = $('#preview-banner');
  if (b) b.hidden = !show;
}

// 데모 데이터 (오늘 기준 상대 날짜 → '먹어도 OK'와 'N일 남음' 둘 다 보이게)
function seedDemo() {
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
  const demo = [
    { name: '떡볶이', cd: 30, ago: 5 },
    { name: '삼겹살', cd: 7, ago: 10 },
    { name: '라면', cd: 14, ago: 0 },
    { name: '치킨', cd: 10, ago: 13 },
  ];
  menus = []; records = [];
  demo.forEach((d, i) => {
    const id = 'demo-' + i;
    menus.push({ id, name: d.name, cooldownDays: d.cd, createdAt: i });
    records.push({ id: 'demo-r-' + i, menuId: id, name: d.name, date: daysAgo(d.ago), note: '', nutrition: null, createdAt: i });
  });
}

function enterPreview() {
  guestMode = true;
  currentUser = null;
  profile = null;
  loadedForUser = null;
  newlyReady = new Set();
  seedDemo();
  renderAll();
  setGate(true);
  togglePreviewBanner(true);
}

function requireAuth(msg) {
  toast(msg || '로그인하면 저장할 수 있어요');
  setGate(false);
  togglePreviewBanner(false);
  showAuthScreen('signup');
}

async function enterApp(session) {
  if (!session) return;
  if (loadedForUser === session.user.id) { setGate(true); return; }
  guestMode = false;
  togglePreviewBanner(false);
  currentUser = session.user;
  try {
    await store.loadAll();
  } catch (err) {
    toast('데이터 로드 실패: ' + authMsg(err));
    return;
  }
  loadedForUser = currentUser.id;
  await maybeImportLegacy();
  computeNewlyReady();
  renderAll();
  setGate(true);
  notifyNewlyReady();
}

function leaveApp() {
  // 로그아웃/세션 없음 → 로그인 벽 대신 미리보기로
  enterPreview();
}

function initAuth() {
  if (!CONFIG_READY) {
    setGate(false);
    showAuthScreen('config');
    return;
  }
  sb.auth.onAuthStateChange((event, session) => {
    // supabase-js 콜백 안에서 곧바로 다른 supabase 호출 시 교착 가능 → 밖으로 미룸
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') { setGate(false); showAuthScreen('recovery'); return; }
      if (session) enterApp(session);
      else leaveApp();
    }, 0);
  });
}

function initAuthUI() {
  // 화면 전환 링크
  $('#auth-view').addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]')?.dataset.goto;
    if (!goto) return;
    e.preventDefault();
    if (goto === 'preview') { enterPreview(); return; }
    showAuthScreen(goto);
  });

  // 미리보기 배너 / 게스트 계정 → 로그인 화면
  ['#btn-preview-login', '#btn-guest-login'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('click', () => { setGate(false); togglePreviewBanner(false); showAuthScreen('login'); });
  });

  // 로그인
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sb) return;
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({
      email: $('#login-email').value.trim(),
      password: $('#login-password').value,
    });
    btn.disabled = false;
    if (error) showFormError('#login-error', authMsg(error));
    // 성공 시 onAuthStateChange가 화면 전환
  });

  // 회원가입
  $('#signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sb) return;
    const email = $('#signup-email').value.trim();
    const pw = $('#signup-password').value;
    const pw2 = $('#signup-password2').value;
    if (pw.length < 8) return showFormError('#signup-error', '비밀번호는 8자 이상이어야 해요.');
    if (pw !== pw2) return showFormError('#signup-error', '비밀번호 확인이 일치하지 않아요.');

    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const { data, error } = await sb.auth.signUp({ email, password: pw });
    btn.disabled = false;
    if (error) return showFormError('#signup-error', authMsg(error));

    // 이미 가입된 이메일이면 identities가 빈 배열로 옴 (정보 노출 방지 정책)
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return showFormError('#signup-error', '이미 가입된 이메일입니다. 로그인하거나 비밀번호 찾기를 이용하세요.');
    }
    if (!data.session) {
      showNotice('📮 인증 메일을 보냈어요',
        `${email} 받은편지함(스팸함 포함)에서 인증 링크를 누르면 가입이 완료됩니다.`);
    }
    // 인증 꺼진 프로젝트면 session이 바로 생겨 onAuthStateChange가 처리
  });

  // 비밀번호 찾기
  $('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sb) return;
    const email = $('#forgot-email').value.trim();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    btn.disabled = false;
    if (error) return showFormError('#forgot-error', authMsg(error));
    showNotice('📮 재설정 메일을 보냈어요', `${email}의 링크를 누르면 새 비밀번호를 설정할 수 있어요.`);
  });

  // 새 비밀번호 설정 (재설정 링크 진입)
  $('#recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sb) return;
    const pw = $('#recovery-password').value;
    if (pw.length < 8) return showFormError('#recovery-error', '비밀번호는 8자 이상이어야 해요.');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: pw });
    btn.disabled = false;
    if (error) return showFormError('#recovery-error', authMsg(error));
    toast('비밀번호가 변경됐어요 ✅');
    const { data: { session } } = await sb.auth.getSession();
    await enterApp(session);
  });

  // 계정 카드 (관리 탭)
  $('#btn-logout').addEventListener('click', async () => {
    if (!sb) return;
    await sb.auth.signOut().catch(() => {});
    toast('로그아웃 됐어요 👋');
  });

  $('#btn-change-pw').addEventListener('click', () => {
    const box = $('#pw-change-box');
    box.hidden = !box.hidden;
  });
  $('#btn-save-pw').addEventListener('click', async () => {
    if (!sb) return;
    const pw = $('#new-password').value;
    if (pw.length < 8) { toast('비밀번호는 8자 이상이어야 해요.'); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { toast('변경 실패: ' + authMsg(error)); return; }
    $('#new-password').value = '';
    $('#pw-change-box').hidden = true;
    toast('비밀번호가 변경됐어요 ✅');
  });

  $('#btn-delete-account').addEventListener('click', async () => {
    if (!sb) return;
    if (!confirm('정말 탈퇴할까요? 모든 기록이 영구 삭제됩니다.')) return;
    if (!confirm('마지막 확인입니다. 되돌릴 수 없어요. 진행할까요?')) return;
    const { error } = await sb.rpc('delete_own_account');
    if (error) { toast('탈퇴 실패: ' + authMsg(error)); return; }
    await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    leaveApp();
    toast('탈퇴가 완료됐어요. 안녕히 가세요 👋');
  });
}

/* =========================================================================
 *  v1 localStorage 데이터 이관 (1회 제안)
 * ======================================================================= */
async function maybeImportLegacy() {
  if (localStorage.getItem(LS.migrateDismissed)) return;
  const oldMenus = loadJSON(LS.legacyMenus, []);
  const oldRecords = loadJSON(LS.legacyRecords, []);
  if (!oldMenus.length && !oldRecords.length) return;

  const ok = confirm(
    `이 브라우저에 예전(로컬 저장) 기록이 있어요 — 메뉴 ${oldMenus.length}개, 기록 ${oldRecords.length}건.\n` +
    `지금 계정으로 가져올까요?\n\n(취소하면 다시 묻지 않지만, 데이터는 브라우저에 남아 있습니다)`
  );
  if (!ok) { localStorage.setItem(LS.migrateDismissed, '1'); return; }

  try {
    await importData({ menus: oldMenus, records: oldRecords });
    // 성공: 원본을 백업 키로 이동
    localStorage.setItem('cooldown.migrated.menus', JSON.stringify(oldMenus));
    localStorage.setItem('cooldown.migrated.records', JSON.stringify(oldRecords));
    localStorage.removeItem(LS.legacyMenus);
    localStorage.removeItem(LS.legacyRecords);
    toast(`로컬 기록 ${oldRecords.length}건을 계정으로 가져왔어요! 📥`);
  } catch (err) {
    toast('가져오기 실패: ' + authMsg(err));
  }
}

// menus/records 형태의 JSON을 계정으로 삽입 (이관·파일 가져오기 공용)
async function importData(data) {
  const menuIdMap = {};
  for (const om of data.menus || []) {
    if (!om || !om.name) continue;
    const m = await store.upsertMenu(om.name, om.cooldownDays != null ? Number(om.cooldownDays) : null);
    if (om.id) menuIdMap[om.id] = m.id;
  }
  const rows = [];
  for (const or of data.records || []) {
    if (!or || !or.date) continue;
    let mid = or.menuId ? menuIdMap[or.menuId] : null;
    if (!mid && or.name) mid = (await store.upsertMenu(or.name, null)).id;
    if (!mid) continue;
    rows.push({ menu_id: mid, eaten_on: or.date, note: or.note || null, nutrition: or.nutrition || null });
  }
  if (rows.length) {
    const { error } = await sb.from('records').insert(rows);
    if (error) throw error;
  }
  await store.loadAll();
  renderAll();
}

/* =========================================================================
 *  인앱 '쿨타임 완료' 알림
 * ======================================================================= */
function computeNewlyReady() {
  const last = Number(localStorage.getItem(LS.lastSeen) || 0);
  const now = Date.now();
  newlyReady = new Set();
  if (last > 0) {
    for (const m of menus) {
      const s = menuStatus(m);
      if (s.last && s.available && s.nextDate &&
          s.nextDate.getTime() > last && s.nextDate.getTime() <= now) {
        newlyReady.add(m.id);
      }
    }
  }
  localStorage.setItem(LS.lastSeen, String(now));
}
function notifyNewlyReady() {
  updateTabDot();
  if (!newlyReady.size) return;
  const names = [...newlyReady].map((id) => getMenu(id)?.name).filter(Boolean);
  if (!names.length) return;
  const label = names.length === 1 ? `"${names[0]}"` : `"${names[0]}" 외 ${names.length - 1}개`;
  toast(`🎉 ${label} 쿨타임 완료! 이제 먹어도 돼요`);
}
function updateTabDot() {
  $('[data-tab=cooldown]').classList.toggle('has-dot', newlyReady.size > 0);
}

/* =========================================================================
 *  렌더링 (v1과 동일 구조)
 * ======================================================================= */
let lastNutrition = null;

function renderRecordTab() {
  $('#menu-suggestions').innerHTML = menus.map((m) => `<option value="${escapeHtml(m.name)}">`).join('');

  const recent = [...records]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt))
    .slice(0, 12);
  $('#record-count').textContent = records.length ? `총 ${records.length}개` : '';

  const list = $('#recent-list');
  if (!recent.length) {
    list.innerHTML = `<li class="empty">아직 기록이 없어요. 위에서 첫 기록을 남겨보세요! 🍽️</li>`;
    return;
  }
  list.innerHTML = recent.map((r) => {
    const n = r.nutrition;
    const nutri = n ? ` · ${n.calories}kcal` : '';
    return `<li class="record-item">
      <div class="ri-main">
        <div class="ri-name">${escapeHtml(r.name)}</div>
        <div class="ri-meta">${r.date}${nutri}</div>
        ${r.note ? `<div class="ri-note">${escapeHtml(r.note)}</div>` : ''}
      </div>
      <button class="icon-btn" data-del-record="${r.id}" title="삭제">✕</button>
    </li>`;
  }).join('');
}

function renderCooldownTab() {
  const statuses = menus.map(menuStatus).filter((s) => s.last);
  const ready = statuses.filter((s) => s.available).sort((a, b) => b.elapsed - a.elapsed);
  const waiting = statuses.filter((s) => !s.available).sort((a, b) => a.daysRemaining - b.daysRemaining);

  $('#summary').innerHTML = `
    <div class="stat"><div class="num">${statuses.length}</div><div class="lbl">기록된 메뉴</div></div>
    <div class="stat ok"><div class="num">${ready.length}</div><div class="lbl">지금 OK</div></div>
    <div class="stat wait"><div class="num">${waiting.length}</div><div class="lbl">쿨타임 중</div></div>`;

  const groups = $('#cooldown-groups');
  if (!statuses.length) {
    groups.innerHTML = `<div class="card"><div class="empty">기록을 남기면 여기에 쿨타임 현황이 표시돼요. ⏳</div></div>`;
    return;
  }

  let html = '';
  if (ready.length) {
    html += `<div class="group-title">지금 먹어도 OK</div>`;
    html += ready.map(cdCard).join('');
  }
  if (waiting.length) {
    html += `<div class="group-title">쿨타임 중</div>`;
    html += waiting.map(cdCard).join('');
  }
  groups.innerHTML = html;
}

function cdCard(s) {
  const since = s.elapsed === 0 ? '오늘' : `${s.elapsed}일 전`;
  const isNew = newlyReady.has(s.menu.id);
  const status = s.available
    ? `<span class="cd-status ready">먹어도 OK</span>`
    : `<span class="cd-status wait">${s.daysRemaining}일 남음</span>`;
  const meta = s.available
    ? `마지막: ${s.last.date} (${since}) · 쿨타임 ${s.menu.cooldownDays}일`
    : `마지막: ${s.last.date} (${since}) · 다음 가능일 <b>${ymd(s.nextDate)}</b>`;
  return `<div class="cd-card ${s.available ? 'ready' : ''}">
    <div class="cd-top"><span class="cd-name">${escapeHtml(s.menu.name)}${isNew ? '<span class="badge-new">새로 완료</span>' : ''}</span>${status}</div>
    <div class="cd-meta">${meta}</div>
    <div class="bar"><span style="width:${Math.round(s.progress * 100)}%"></span></div>
  </div>`;
}

function renderManageTab() {
  const list = $('#menu-list');
  if (!menus.length) {
    list.innerHTML = `<li class="empty">아직 메뉴가 없어요.</li>`;
  } else {
    const sorted = [...menus].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    list.innerHTML = sorted.map((m) => {
      const cnt = records.filter((r) => r.menuId === m.id).length;
      return `<li class="menu-item">
        <span class="mi-name">${escapeHtml(m.name)} <span class="muted small">(${cnt}회)</span></span>
        <input class="mi-cooldown" type="number" min="0" step="1" value="${m.cooldownDays}" data-menu-cd="${m.id}" />
        <span class="mi-unit">일</span>
        <button class="icon-btn" data-del-menu="${m.id}" title="메뉴 삭제">✕</button>
      </li>`;
    }).join('');
  }

  $('#set-default-cooldown').value = defaultCooldown();
  $('#set-provider').value = llm.provider;
  $('#set-recognizer').value = llm.recognizer;
  $('#acc-email').textContent = currentUser ? currentUser.email : '';
  const au = $('#account-user'), ag = $('#account-guest');
  if (au) au.hidden = guestMode;
  if (ag) ag.hidden = !guestMode;
  renderProviderConfig();
  renderRecognizerConfig();
}

function renderProviderConfig() {
  const p = llm.provider;
  const box = $('#provider-config');
  if (p === 'mock') { box.hidden = true; return; }
  box.hidden = false;
  $('#set-key').value = llm.keys[p] || '';
  $('#set-model').value = llm.models[p] || '';
}

function renderRecognizerConfig() {
  const p = llm.recognizer;
  const rec = RECOGNIZERS[p] || RECOGNIZERS.mock;
  const box = $('#recognizer-config');
  if (!rec.needsKey) { box.hidden = true; return; } // mock/tesseract는 키 불필요
  box.hidden = false;
  $('#set-recognizer-key').value = llm.keys[p] || '';
}

function renderAll() {
  renderRecordTab();
  renderCooldownTab();
  renderManageTab();
  updateTabDot();
}

/* =========================================================================
 *  이벤트 바인딩
 * ======================================================================= */
function initTabs() {
  $('#tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    const tab = btn.dataset.tab;
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab}`));
    if (tab === 'cooldown') btn.classList.remove('has-dot'); // 알림 점 해제 (배지는 유지)
  });
}

function initRecordForm() {
  $('#f-date').value = todayStr();

  $('#f-name').addEventListener('change', () => {
    const m = findMenuByName($('#f-name').value);
    if (m) $('#f-cooldown').value = m.cooldownDays;
  });

  // AI 분석
  $('#btn-ai').addEventListener('click', async () => {
    const name = $('#f-name').value.trim();
    if (!name) { toast('먼저 메뉴 이름을 입력하세요.'); return; }
    const btn = $('#btn-ai');
    const hint = $('#ai-hint');
    btn.disabled = true;
    hint.textContent = `분석 중… (${(PROVIDERS[llm.provider] || PROVIDERS.mock).label})`;
    try {
      const n = await analyzeNutrition(name);
      lastNutrition = n;
      showNutrition(n);
      if (!$('#f-note').value.trim() && n.healthNote) $('#f-note').value = n.healthNote;
      if (!$('#f-cooldown').value && n.suggestedCooldownDays) $('#f-cooldown').value = n.suggestedCooldownDays;
      hint.textContent = '';
    } catch (err) {
      hint.textContent = '';
      toast('분석 실패: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // 저장 (클라우드)
  $('#record-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (guestMode) { requireAuth('가입하면 이 기록을 저장할 수 있어요'); return; }
    const name = $('#f-name').value.trim();
    const date = $('#f-date').value || todayStr();
    const note = $('#f-note').value.trim();
    const cdRaw = $('#f-cooldown').value;
    if (!name) return;

    const submitBtn = e.target.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    try {
      const cooldownDays = cdRaw === '' ? null : Math.max(0, parseInt(cdRaw, 10) || 0);
      const menu = await store.upsertMenu(name, cooldownDays);
      await store.addRecord({ menuId: menu.id, date, note, nutrition: lastNutrition });

      e.target.reset();
      $('#f-date').value = todayStr();
      hideNutrition();
      resetPhotoUI();
      lastNutrition = null;
      renderAll();
      toast(`"${menu.name}" 기록 완료! ✅`);
    } catch (err) {
      toast('저장 실패: ' + authMsg(err));
    } finally {
      submitBtn.disabled = false;
    }
  });

  // 기록 삭제
  $('#recent-list').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del-record]')?.dataset.delRecord;
    if (!id) return;
    if (guestMode) { requireAuth(); return; }
    try {
      await store.deleteRecord(id);
      renderAll();
    } catch (err) {
      toast('삭제 실패: ' + authMsg(err));
    }
  });

  // 📷 사진으로 기록
  $('#btn-photo').addEventListener('click', () => $('#photo-file').click());
  $('#photo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // 같은 파일 다시 선택 가능하게
    if (!file) return;
    const btn = $('#btn-photo');
    const hint = $('#photo-hint');
    btn.disabled = true;
    $('#photo-box').hidden = false;
    hint.textContent = '이미지 준비 중…';
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      showPhotoPreview(dataUrl);
      const rec = RECOGNIZERS[llm.recognizer] || RECOGNIZERS.mock;
      hint.textContent = `인식 중… (${rec.label})`;
      const r = await recognizeMenu(dataUrl);
      hint.textContent = '';
      handleRecognition(r);
    } catch (err) {
      hint.textContent = '';
      toast('사진 인식 실패: ' + (err.message || err));
    } finally {
      btn.disabled = false;
    }
  });

  // 후보 칩 클릭 → 이름 채움
  $('#photo-candidates').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cand]')?.dataset.cand;
    if (!c) return;
    const el = $('#f-name');
    el.value = c;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function showPhotoPreview(dataUrl) {
  $('#photo-box').hidden = false;
  const img = $('#f-photo-preview');
  img.src = dataUrl;
  img.hidden = false;
}
function resetPhotoUI() {
  $('#photo-box').hidden = true;
  const img = $('#f-photo-preview');
  img.removeAttribute('src');
  img.hidden = true;
  $('#photo-hint').textContent = '';
  const cands = $('#photo-candidates');
  cands.hidden = true;
  cands.innerHTML = '';
}
function handleRecognition(r) {
  const cands = $('#photo-candidates');
  if (r.name) {
    const el = $('#f-name');
    el.value = r.name;
    el.dispatchEvent(new Event('change', { bubbles: true })); // 쿨타임 자동채움 트리거
  }
  if (r.candidates && r.candidates.length > 1) {
    cands.hidden = false;
    cands.innerHTML = '<span class="cand-label">후보:</span>' +
      r.candidates.map((c) => `<button type="button" class="cand" data-cand="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
  } else {
    cands.hidden = true;
    cands.innerHTML = '';
  }
  if (!r.name) {
    toast('메뉴명을 인식하지 못했어요. 이름을 직접 입력하세요.');
    if (r.rawText && !$('#f-note').value.trim()) $('#f-note').value = r.rawText.slice(0, 200);
  } else if (r.confidence != null && r.confidence < 0.5) {
    toast('정확도가 낮아요 — 이름을 확인·수정하세요.');
  } else {
    toast(`"${r.name}"(으)로 인식했어요. 확인 후 저장하세요.`);
  }
}

function showNutrition(n) {
  const box = $('#f-nutrition');
  box.hidden = false;
  box.innerHTML = `
    <span class="chip">🔥 ${n.calories} kcal</span>
    <span class="chip">탄수 ${n.carbs}g</span>
    <span class="chip">단백 ${n.protein}g</span>
    <span class="chip">지방 ${n.fat}g</span>
    <span class="chip">나트륨 ${n.sodium}mg</span>
    ${n.suggestedCooldownDays != null ? `<span class="chip">권장 간격 ${n.suggestedCooldownDays}일</span>` : ''}
    ${n.healthNote ? `<div class="note">💬 ${escapeHtml(n.healthNote)}</div>` : ''}`;
}
function hideNutrition() { const box = $('#f-nutrition'); box.hidden = true; box.innerHTML = ''; }

function initManage() {
  // 메뉴 쿨타임 인라인 수정
  $('#menu-list').addEventListener('change', async (e) => {
    const id = e.target.dataset.menuCd;
    if (!id) return;
    if (guestMode) { requireAuth(); return; }
    const days = Math.max(0, parseInt(e.target.value, 10) || 0);
    try {
      await store.updateMenuCooldown(id, days);
      renderCooldownTab();
    } catch (err) {
      toast('수정 실패: ' + authMsg(err));
    }
  });

  // 메뉴 삭제
  $('#menu-list').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del-menu]')?.dataset.delMenu;
    if (!id) return;
    if (guestMode) { requireAuth(); return; }
    const m = getMenu(id);
    const cnt = records.filter((r) => r.menuId === id).length;
    if (!confirm(`"${m?.name}" 메뉴와 관련 기록 ${cnt}개를 삭제할까요?`)) return;
    try {
      await store.deleteMenu(id);
      renderAll();
    } catch (err) {
      toast('삭제 실패: ' + authMsg(err));
    }
  });

  // 기본 쿨타임 (계정 프로필에 저장)
  $('#set-default-cooldown').addEventListener('change', async (e) => {
    if (guestMode) { requireAuth(); return; }
    const v = Math.max(0, parseInt(e.target.value, 10) || 0);
    try {
      await store.updateProfile({ default_cooldown_days: v });
      toast('기본 쿨타임을 저장했어요 ✅');
    } catch (err) {
      toast('저장 실패: ' + authMsg(err));
    }
  });

  // LLM 설정 (기기 로컬)
  $('#set-provider').addEventListener('change', (e) => {
    llm.provider = e.target.value;
    saveLlm();
    renderProviderConfig();
  });
  $('#set-key').addEventListener('change', (e) => {
    if (llm.provider !== 'mock') { llm.keys[llm.provider] = e.target.value.trim(); saveLlm(); }
  });
  $('#set-model').addEventListener('change', (e) => {
    if (llm.provider !== 'mock') { llm.models[llm.provider] = e.target.value.trim(); saveLlm(); }
  });

  // 사진 인식 공급자 (기기 로컬)
  $('#set-recognizer').addEventListener('change', (e) => {
    llm.recognizer = e.target.value;
    saveLlm();
    renderRecognizerConfig();
  });
  $('#set-recognizer-key').addEventListener('change', (e) => {
    const p = llm.recognizer;
    if (llm.keys[p] != null) { llm.keys[p] = e.target.value.trim(); saveLlm(); }
  });

  // 데이터 내보내기 (키 등 민감정보는 제외)
  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob(
      [JSON.stringify({ menus, records, exportedAt: todayStr() }, null, 2)],
      { type: 'application/json' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cooldown-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // 데이터 가져오기 (계정으로 삽입)
  $('#import-file').addEventListener('change', (e) => {
    if (guestMode) { requireAuth(); e.target.value = ''; return; }
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        await importData(data);
        toast('가져오기 완료! 📥');
      } catch (err) {
        toast('가져오기 실패: ' + authMsg(err));
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  // 전체 삭제 (계정 데이터)
  $('#btn-reset').addEventListener('click', async () => {
    if (guestMode) { requireAuth(); return; }
    if (!confirm('모든 기록과 메뉴를 삭제할까요? 되돌릴 수 없습니다.')) return;
    try {
      await store.deleteAllData();
      renderAll();
      toast('전체 삭제 완료');
    } catch (err) {
      toast('삭제 실패: ' + authMsg(err));
    }
  });
}

/* ---------- 시작 ---------- */
initTabs();
initRecordForm();
initManage();
initAuthUI();
initAuth();
