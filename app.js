'use strict';

/* =========================================================================
 *  쿨타임 트래커 v2 — 계정(Supabase Auth) + 클라우드 DB(Postgres/RLS)
 *  - 로그인 필수. 기록·메뉴는 본인 계정에만 저장(행 단위 보안).
 *  - 비밀번호는 우리 DB에 없음 — Supabase Auth가 해시로 관리.
 *  - AI: 사진 자동 인식(서버 프록시=builtin) + 메모 자동 채움(서버 Gemma).
 *    비전 BYOK 인식기(claude/openai/gemini)의 키는 이 브라우저(localStorage)에만 저장.
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
  lastSeen: 'cooldown.lastSeenAt',        // 인앱 '새로 완료' 판단 기준(계정별: 뒤에 user.id 붙임)
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
    recognizer: 'builtin',
    keys: Object.assign({ claude: '', openai: '', gemini: '' }, legacy.keys || {}),
    models: Object.assign(
      { claude: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini', gemini: 'gemini-2.0-flash' },
      legacy.models || {}
    ),
  };
  saveJSON(LS.llm, llm);
}
if (llm) {
  // 인식기 정리: 누락 또는 (개발용) mock/openrouter → 서버 자동 인식(builtin)으로.
  // mock은 네트워크 없이 항상 '떡볶이'만 즉시 반환하는 placeholder라 실사용 대상이 아님.
  if (!llm.recognizer || llm.recognizer === 'mock' || llm.recognizer === 'openrouter') llm.recognizer = 'builtin';
  if (llm.provider === 'openrouter') llm.provider = 'mock'; // (구) 영양분석 openrouter 정리
  saveJSON(LS.llm, llm);
}
function saveLlm() { saveJSON(LS.llm, llm); }

/* ---------- 앱 상태 (클라우드 캐시) ---------- */
let currentUser = null;   // Supabase user
let profile = null;       // profiles 행
let menus = [];           // [{id, name, cooldownDays, createdAt}]
let records = [];         // [{id, menuId, name, date, note, createdAt}]
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

  async addRecord({ menuId, date, note }) {
    const { data, error } = await sb.from('records')
      .insert({ menu_id: menuId, eaten_on: date, note: note || null })
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
 *  공용 파서 — 비전 인식기(claude/openai/gemini) 응답에서 JSON 추출
 * ======================================================================= */
// 첫 번째 '완전한' JSON 객체만 추출 (모델이 JSON 뒤에 군더더기를 붙여도 안전)
function extractJson(text) {
  if (!text) throw new Error('빈 응답');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('JSON을 찾지 못함: ' + text.slice(0, 120));
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
  throw new Error('JSON을 찾지 못함: ' + text.slice(0, 120));
}

/* =========================================================================
 *  사진 인식 — 공급자 무관 어댑터 (recognizeMenu 하나로 설정된 인식기 호출)
 *  recognizeMenu(dataUrl) 하나만 호출하면 설정된 인식 공급자가 처리.
 *  - mock: 무료·로컬 데모
 *  - tesseract: 기기 내 OCR (메뉴판/영수증 글자). 키 불필요, 최초 로딩 수 MB
 *  - claude/openai/gemini: 비전 (음식 접시 인식). 본인 키 + 호출당 과금 + 사진 외부 전송
 *  반환(정규화): { name, candidates[], confidence, rawText }
 * ======================================================================= */
const RECOGNIZE_SYS =
  '사진 속 음식을 인식해 대표 메뉴명을 최대 4개까지 한국어로 추출한다. ' +
  '반드시 JSON 하나만 출력한다: {"candidates":["메뉴1","메뉴2"]}. ' +
  '각 항목은 짧은 메뉴명(예: 떡볶이, 김밥). 설명·문장·마크다운·코드블록 금지. ' +
  '음식이 안 보이면 {"candidates":[]}.';

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('이미지 형식 오류');
  return { mediaType: m[1], base64: m[2] };
}
function normalizeRecognition(o) {
  o = o || {};
  const conf = Number(o.confidence);
  const candidates = Array.isArray(o.candidates)
    ? o.candidates.map((c) => String(c).trim()).filter(Boolean).slice(0, 4)
    : [];
  return {
    name: o.name ? String(o.name).trim() : (candidates[0] || ''),
    candidates,
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

// 모델 폴백 체인으로 서버 AI 함수 호출. 앞 모델이 실패하면 다음 모델로 전환(전환 시 안내).
async function callAiWithFallback(body, isSuccess) {
  const fn = (window.COOLTIME_CONFIG && window.COOLTIME_CONFIG.RECOGNIZE_FUNCTION) || 'recognize';
  const models = (window.COOLTIME_CONFIG && window.COOLTIME_CONFIG.RECOGNIZE_MODELS) || ['gemma-4-31b-it'];
  let lastErr = 'AI 응답 없음';
  for (let i = 0; i < models.length; i++) {
    if (i > 0) toast('첫번째 모델에 오류가 있어서, 다른 모델로 재시도 중입니다.');
    try {
      const { data, error } = await sb.functions.invoke(fn, { body: Object.assign({}, body, { model: models[i] }) });
      if (error) {
        lastErr = error.message || String(error);
        const status = (error.context && error.context.status) || 0;
        try { const b = await error.context.json(); if (b && b.error) lastErr = b.error; } catch (_) {}
        if (status === 400 || status === 401) break; // 모델 무관 오류(입력/인증) → 즉시 중단(불필요한 재시도·팝업 방지)
        continue; // 5xx/429 등은 다음 모델로
      }
      if (data && data.error) { lastErr = data.error; continue; }
      if (isSuccess(data)) return data;
      lastErr = '결과 없음'; // 유효 응답이나 쓸 결과 없음 → 다음 모델
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
  }
  throw new Error(lastErr);
}

const RECOGNIZERS = {
  /* ---- 서비스 내장: 관리자 키를 쓰는 Supabase Edge Function 프록시 (키 노출 없음, 모델 폴백) ---- */
  builtin: {
    label: '자동 인식 (서비스 제공)', needsKey: false,
    async recognize(dataUrl) {
      if (!currentUser) throw new Error('로그인하면 사진 자동 인식을 쓸 수 있어요.');
      const data = await callAiWithFallback({ image: dataUrl }, (d) => !!d); // 응답만 오면 성공(빈 후보는 '음식 없음')
      return normalizeRecognition({ name: data.name, candidates: data.candidates });
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
  const rec = RECOGNIZERS[llm.recognizer] || RECOGNIZERS.builtin;
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
let hadAuthedSession = false; // 이 페이지에서 로그인한 적 있는지 (로그아웃 vs 최초 방문 구분)

function togglePreviewBanner(show) {
  const b = $('#preview-banner');
  if (b) b.hidden = !show;
}

// 데모 데이터: 떡볶이 1건만 (기록→쿨타임→관리 세 탭이 같은 배열을 그리므로 자동 sync)
function seedDemo() {
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
  menus = [{ id: 'demo-0', name: '떡볶이', cooldownDays: 30, createdAt: 0 }];
  records = [{ id: 'demo-r-0', menuId: 'demo-0', name: '떡볶이', date: daysAgo(5), note: '이건 예시 기록이에요. 로그인하면 내 기록으로 시작합니다.', createdAt: 0 }];
}
// 게스트 미리보기에서 항목 옆에 붙는 '[예시]' 태그
function demoBadge() { return guestMode ? ' <span class="badge-demo">[예시]</span>' : ''; }

function enterPreview() {
  guestMode = true;
  currentUser = null;
  profile = null;
  loadedForUser = null;
  newlyReady = new Set();
  seedDemo();
  renderAll();
  $('#f-cooldown').value = defaultCooldown();
  setGate(true);
  togglePreviewBanner(true);
}

function requireAuth(msg) {
  toast(msg || '로그인하면 저장할 수 있어요');
  setGate(false);
  togglePreviewBanner(false);
  showAuthScreen('signup');
}
// 게스트면 안내 후 true 반환 — 쓰기 핸들러에서 `if (blockGuest(msg)) return;` 로 가드
function blockGuest(msg) {
  if (!guestMode) return false;
  requireAuth(msg);
  return true;
}
// 표준 실패 토스트 — '<액션> 실패: <사용자 친화 메시지>'
function failToast(action, err) { toast(action + ' 실패: ' + authMsg(err)); }

async function enterApp(session) {
  if (!session) return;
  if (loadedForUser === session.user.id) { setGate(true); return; }
  guestMode = false;
  togglePreviewBanner(false);
  currentUser = session.user;
  hadAuthedSession = true;
  try {
    await store.loadAll();
  } catch (err) {
    failToast('데이터 로드', err);
    return;
  }
  loadedForUser = currentUser.id;
  await maybeImportLegacy();
  computeNewlyReady();
  renderAll();
  $('#f-cooldown').value = defaultCooldown();
  setGate(true);
  notifyNewlyReady();
}

function leaveApp() {
  // 명시적 로그아웃 → 로그인 화면(깔끔한 나가기). 메모리 비우고 배너 끔.
  guestMode = false;
  currentUser = null; profile = null;
  menus = []; records = [];
  loadedForUser = null;
  newlyReady = new Set();
  setGate(false);
  togglePreviewBanner(false);
  showAuthScreen('login');
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
      if (event === 'PASSWORD_RECOVERY') { setGate(false); togglePreviewBanner(false); showAuthScreen('recovery'); return; }
      if (session) { enterApp(session); return; }
      // 세션 없음: 명시적 로그아웃 → 로그인 화면 / 최초 방문·둘러보기 → 데모 미리보기
      if (event === 'SIGNED_OUT' && hadAuthedSession) leaveApp();
      else enterPreview();
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
    failToast('가져오기', err);
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
    rows.push({ menu_id: mid, eaten_on: or.date, note: or.note || null });
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
  // 기준시각은 계정별로 분리 — 공유기기에서 A의 기준이 B에게 새어들어 '새로 완료' 오알림 나던 문제 방지
  const key = LS.lastSeen + '.' + (currentUser ? currentUser.id : 'guest');
  const last = Number(localStorage.getItem(key) || 0);
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
  localStorage.setItem(key, String(now));
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
  list.innerHTML = recent.map((r, i) => {
    return `<li class="record-item">
      <span class="ri-idx">R-${String(i + 1).padStart(2, '0')}</span>
      <div class="ri-main">
        <div class="ri-name">${escapeHtml(r.name)}${demoBadge()}</div>
        <div class="ri-meta">${r.date}</div>
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
    <div class="stat">MENUS <b>${statuses.length}</b></div>
    <div class="stat">OK <b>${ready.length}</b></div>
    <div class="stat act">ACTIVE <b>${waiting.length}</b></div>`;

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
  // 원형 게이지: 경과율만큼 오렌지 호(stroke-dasharray), 12시 방향 시작(-90deg), 끝은 각지게(butt)
  const C = 2 * Math.PI * 38; // r=38 원주 ≈ 238.8
  const p = Math.max(0, Math.min(1, s.progress));
  const dash = `${(p * C).toFixed(1)} ${(C - p * C).toFixed(1)}`;
  const isNew = newlyReady.has(s.menu.id);
  const center = s.available
    ? `<text x="46" y="42" text-anchor="middle" class="g-num" font-size="18">OK</text>
       <text x="46" y="58" text-anchor="middle" class="g-sub">READY</text>`
    : `<text x="46" y="42" text-anchor="middle" class="g-num">${s.daysRemaining}</text>
       <text x="46" y="58" text-anchor="middle" class="g-sub">DAYS LEFT</text>`;
  const aria = s.available ? `${s.menu.name} 쿨타임 완료` : `${s.menu.name} ${s.daysRemaining}일 남음`;
  return `<div class="cd-card${s.available ? ' ready' : ''}">
    <svg class="gauge" width="92" height="92" viewBox="0 0 92 92" role="img" aria-label="${escapeHtml(aria)}">
      <circle cx="46" cy="46" r="38" fill="none" stroke="rgba(0,0,0,.12)" stroke-width="6"/>
      <circle cx="46" cy="46" r="38" fill="none" stroke="#FF5A1F" stroke-width="6"
        stroke-dasharray="${dash}" stroke-linecap="butt" transform="rotate(-90 46 46)"/>
      ${center}
    </svg>
    <div class="cd-info">
      <div class="cd-name">${escapeHtml(s.menu.name)}${demoBadge()}${isNew ? '<span class="badge-new">새로 완료</span>' : ''}</div>
      <div class="cd-meta">LAST ${s.last.date} (D+${s.elapsed})<br>NEXT ${ymd(s.nextDate)}</div>
    </div>
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
        <span class="mi-name">${escapeHtml(m.name)}${demoBadge()} <span class="muted small">(${cnt}회)</span></span>
        <input class="mi-cooldown" type="number" min="0" step="1" value="${m.cooldownDays}" data-menu-cd="${m.id}" />
        <span class="mi-unit">일</span>
        <button class="icon-btn" data-del-menu="${m.id}" title="메뉴 삭제">✕</button>
      </li>`;
    }).join('');
  }

  $('#set-default-cooldown').value = defaultCooldown();
  $('#set-recognizer').value = llm.recognizer;
  $('#acc-email').textContent = currentUser ? currentUser.email : '';
  const au = $('#account-user'), ag = $('#account-guest');
  if (au) au.hidden = guestMode;
  if (ag) ag.hidden = !guestMode;
  renderRecognizerConfig();
}

function renderRecognizerConfig() {
  const p = llm.recognizer;
  const rec = RECOGNIZERS[p] || RECOGNIZERS.builtin;
  const box = $('#recognizer-config');
  if (!rec.needsKey) { box.hidden = true; return; } // builtin/tesseract는 키 불필요
  box.hidden = false;
  $('#set-recognizer-key').value = llm.keys[p] || '';
  $('#set-recognizer-model').value = llm.models[p] || '';
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
  document.body.dataset.tab = 'record'; // 헤더 부제 표시 여부는 CSS가 body[data-tab]로 판단
  $('#tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    const tab = btn.dataset.tab;
    document.body.dataset.tab = tab;
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab}`));
    if (tab === 'cooldown') btn.classList.remove('has-dot'); // 알림 점 해제 (배지는 유지)
  });
}

// AI 서비스(서버 Gemma) 무응답·실패 시 사용자 안내 문구
const AI_UNAVAILABLE = '현재 AI 서비스가 원활하지 않습니다. 잠시 후 다시 시도해주세요.';

function initRecordForm() {
  $('#f-date').value = todayStr();

  $('#f-name').addEventListener('change', () => {
    const m = findMenuByName($('#f-name').value);
    $('#f-cooldown').value = m ? m.cooldownDays : defaultCooldown();
  });

  // AI 영양정보: 서버(관리자 키) Gemma로 메뉴명 → 한 문장, '메모' 칸만 채움
  $('#btn-ai').addEventListener('click', async () => {
    if (blockGuest('로그인 후 이용이 가능합니다')) return;
    const name = $('#f-name').value.trim();
    if (!name) { toast('먼저 메뉴 이름을 입력하세요.'); return; }
    const btn = $('#btn-ai');
    const hint = $('#ai-hint');
    btn.disabled = true;
    hint.textContent = 'AI가 메모 작성 중…';
    try {
      const data = await callAiWithFallback({ menu: name }, (d) => !!(d && d.note));
      hint.textContent = '';
      $('#f-note').value = data.note;
    } catch (err) {
      hint.textContent = '';
      console.warn('AI 영양정보 실패:', err);
      toast(AI_UNAVAILABLE);
    } finally {
      btn.disabled = false;
    }
  });

  // 저장 (클라우드)
  $('#record-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (blockGuest('가입하면 이 기록을 저장할 수 있어요')) return;
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
      await store.addRecord({ menuId: menu.id, date, note });

      e.target.reset();
      $('#f-date').value = todayStr();
      $('#f-cooldown').value = defaultCooldown();
      resetPhotoUI();
      renderAll();
      toast(`"${menu.name}" 기록 완료! ✅`);
    } catch (err) {
      failToast('저장', err);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // 기록 삭제
  $('#recent-list').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del-record]')?.dataset.delRecord;
    if (!id) return;
    if (blockGuest()) return;
    try {
      await store.deleteRecord(id);
      renderAll();
    } catch (err) {
      failToast('삭제', err);
    }
  });

  // 📷 사진으로 기록
  $('#btn-photo').addEventListener('click', () => {
    if (blockGuest('로그인 후 이용이 가능합니다')) return;
    $('#photo-file').click();
  });
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
      let dataUrl;
      try {
        dataUrl = await fileToResizedDataUrl(file); // 클라이언트 이미지 처리
      } catch (imgErr) {
        hint.textContent = '';
        toast('사진을 불러오지 못했어요. 다른 사진으로 시도해 주세요.');
        return;
      }
      showPhotoPreview(dataUrl);
      const rec = RECOGNIZERS[llm.recognizer] || RECOGNIZERS.builtin;
      hint.textContent = `인식 중… (${rec.label})`;
      const r = await recognizeMenu(dataUrl); // 서버 AI 호출
      hint.textContent = '';
      handleRecognition(r);
    } catch (err) {
      hint.textContent = '';
      console.warn('사진 인식 실패:', err);
      toast(AI_UNAVAILABLE);
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

function initManage() {
  // 메뉴 쿨타임 인라인 수정
  $('#menu-list').addEventListener('change', async (e) => {
    const id = e.target.dataset.menuCd;
    if (!id) return;
    if (blockGuest()) return;
    const days = Math.max(0, parseInt(e.target.value, 10) || 0);
    try {
      await store.updateMenuCooldown(id, days);
      renderCooldownTab();
    } catch (err) {
      failToast('수정', err);
    }
  });

  // 메뉴 삭제
  $('#menu-list').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del-menu]')?.dataset.delMenu;
    if (!id) return;
    if (blockGuest()) return;
    const m = getMenu(id);
    const cnt = records.filter((r) => r.menuId === id).length;
    if (!confirm(`"${m?.name}" 메뉴와 관련 기록 ${cnt}개를 삭제할까요?`)) return;
    try {
      await store.deleteMenu(id);
      renderAll();
    } catch (err) {
      failToast('삭제', err);
    }
  });

  // 기본 쿨타임 (계정 프로필에 저장)
  $('#set-default-cooldown').addEventListener('change', async (e) => {
    if (blockGuest()) return;
    const v = Math.max(0, parseInt(e.target.value, 10) || 0);
    try {
      await store.updateProfile({ default_cooldown_days: v });
      toast('기본 쿨타임을 저장했어요 ✅');
    } catch (err) {
      failToast('저장', err);
    }
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
  $('#set-recognizer-model').addEventListener('change', (e) => {
    const p = llm.recognizer;
    if (llm.models[p] != null) { llm.models[p] = e.target.value.trim(); saveLlm(); }
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
    if (blockGuest()) { e.target.value = ''; return; }
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        await importData(data);
        toast('가져오기 완료! 📥');
      } catch (err) {
        failToast('가져오기', err);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  // 전체 삭제 (계정 데이터)
  $('#btn-reset').addEventListener('click', async () => {
    if (blockGuest()) return;
    if (!confirm('모든 기록과 메뉴를 삭제할까요? 되돌릴 수 없습니다.')) return;
    try {
      await store.deleteAllData();
      renderAll();
      toast('전체 삭제 완료');
    } catch (err) {
      failToast('삭제', err);
    }
  });
}

/* ---------- 시작 ---------- */
initTabs();
initRecordForm();
initManage();
initAuthUI();
initAuth();
