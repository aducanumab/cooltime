'use strict';

/* =========================================================================
 *  쿨타임 트래커 — 먹은 거 기록 & 쿨다운 카운트다운
 *  - 데이터: 브라우저 localStorage (서버 없음)
 *  - AI 영양분석: 공급자 무관 어댑터 구조 (기본 = 무료 데모 mock)
 * ======================================================================= */

/* ---------- 저장소 ---------- */
const STORE = { menus: 'cooldown.menus', records: 'cooldown.records', settings: 'cooldown.settings' };

function loadJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

let menus = loadJSON(STORE.menus, []);
let records = loadJSON(STORE.records, []);
let settings = Object.assign({
  defaultCooldownDays: 30,
  llmProvider: 'mock',
  keys: { claude: '', openai: '', gemini: '' },
  models: { claude: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini', gemini: 'gemini-2.0-flash' },
}, loadJSON(STORE.settings, {}));

function persist() { saveJSON(STORE.menus, menus); saveJSON(STORE.records, records); saveJSON(STORE.settings, settings); }

/* ---------- 유틸 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ---------- 메뉴 헬퍼 ---------- */
function findMenuByName(name) { return menus.find((m) => norm(m.name) === norm(name)); }
function getMenu(id) { return menus.find((m) => m.id === id); }

function ensureMenu(name, cooldownDays) {
  let m = findMenuByName(name);
  if (!m) {
    m = { id: uid(), name: name.trim(), cooldownDays: cooldownDays ?? settings.defaultCooldownDays, createdAt: Date.now() };
    menus.push(m);
  } else if (cooldownDays != null && cooldownDays !== '') {
    m.cooldownDays = cooldownDays;
  }
  return m;
}

/* ---------- 쿨타임 계산 ---------- */
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
 *  AI 영양분석 — 공급자 무관 어댑터
 *  analyzeNutrition(name) 하나만 호출하면, 설정에서 고른 공급자가 처리.
 *  새 LLM을 붙이려면 PROVIDERS 에 어댑터 하나만 추가하면 됩니다.
 *  반환 형태(정규화):
 *    { calories, carbs, protein, fat, sodium, healthNote, suggestedCooldownDays }
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
      await sleep(450); // 비동기 느낌만
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
          'x-api-key': settings.keys.claude,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: settings.models.claude,
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
        headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.keys.openai}` },
        body: JSON.stringify({
          model: settings.models.openai,
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
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.models.gemini}:generateContent?key=${encodeURIComponent(settings.keys.gemini)}`;
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
  const provider = PROVIDERS[settings.llmProvider] || PROVIDERS.mock;
  if (provider.needsKey && !settings.keys[settings.llmProvider]) {
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
  // 일반 추정: 이름 길이로 살짝 변주만
  const seed = norm(name).length;
  return {
    calories: 350 + (seed % 5) * 60,
    carbs: 40 + (seed % 4) * 8,
    protein: 12 + (seed % 3) * 4,
    fat: 12 + (seed % 4) * 5,
    sodium: 700 + (seed % 6) * 120,
    healthNote: '데모 추정치예요. 정확한 값은 AI 공급자를 연결하면 채워집니다.',
    suggestedCooldownDays: settings.defaultCooldownDays,
  };
}

/* =========================================================================
 *  렌더링
 * ======================================================================= */
let lastNutrition = null; // 폼에서 채운 영양정보 임시 보관

function renderRecordTab() {
  // 메뉴 자동완성
  $('#menu-suggestions').innerHTML = menus.map((m) => `<option value="${escapeHtml(m.name)}">`).join('');

  // 최근 기록 (최신순 12개)
  const recent = [...records].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt)).slice(0, 12);
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
  const statuses = menus.map(menuStatus).filter((s) => s.last); // 기록 있는 메뉴만
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
    html += `<div class="group-title">✅ 지금 먹어도 OK</div>`;
    html += ready.map(cdCard).join('');
  }
  if (waiting.length) {
    html += `<div class="group-title">⏳ 쿨타임 중</div>`;
    html += waiting.map(cdCard).join('');
  }
  groups.innerHTML = html;
}

function cdCard(s) {
  const since = s.elapsed === 0 ? '오늘' : `${s.elapsed}일 전`;
  const status = s.available
    ? `<span class="cd-status ready">먹어도 OK 🎉</span>`
    : `<span class="cd-status wait">${s.daysRemaining}일 남음</span>`;
  const meta = s.available
    ? `마지막: ${s.last.date} (${since}) · 쿨타임 ${s.menu.cooldownDays}일`
    : `마지막: ${s.last.date} (${since}) · 다음 가능일 <b>${ymd(s.nextDate)}</b>`;
  return `<div class="cd-card ${s.available ? 'ready' : ''}">
    <div class="cd-top"><span class="cd-name">${escapeHtml(s.menu.name)}</span>${status}</div>
    <div class="cd-meta">${meta}</div>
    <div class="bar"><span style="width:${Math.round(s.progress * 100)}%"></span></div>
  </div>`;
}

function renderManageTab() {
  // 메뉴 목록
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

  // 설정 값 반영
  $('#set-default-cooldown').value = settings.defaultCooldownDays;
  $('#set-provider').value = settings.llmProvider;
  renderProviderConfig();
}

function renderProviderConfig() {
  const p = settings.llmProvider;
  const box = $('#provider-config');
  if (p === 'mock') { box.hidden = true; return; }
  box.hidden = false;
  $('#set-key').value = settings.keys[p] || '';
  $('#set-model').value = settings.models[p] || '';
}

function renderAll() { renderRecordTab(); renderCooldownTab(); renderManageTab(); }

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
  });
}

function initRecordForm() {
  $('#f-date').value = todayStr();

  // 이름 입력 시 기존 메뉴면 쿨타임 자동 채움
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
    hint.textContent = `분석 중… (${(PROVIDERS[settings.llmProvider] || PROVIDERS.mock).label})`;
    try {
      const n = await analyzeNutrition(name);
      lastNutrition = n;
      showNutrition(n);
      // 메모가 비어있으면 건강 코멘트 자동 채움
      if (!$('#f-note').value.trim() && n.healthNote) $('#f-note').value = n.healthNote;
      // 쿨타임 비어있고 추천값 있으면 제안
      if (!$('#f-cooldown').value && n.suggestedCooldownDays) $('#f-cooldown').value = n.suggestedCooldownDays;
      hint.textContent = '';
    } catch (err) {
      hint.textContent = '';
      toast('분석 실패: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // 저장
  $('#record-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#f-name').value.trim();
    const date = $('#f-date').value || todayStr();
    const note = $('#f-note').value.trim();
    const cdRaw = $('#f-cooldown').value;
    if (!name) return;

    const cooldownDays = cdRaw === '' ? null : Math.max(0, parseInt(cdRaw, 10) || 0);
    const menu = ensureMenu(name, cooldownDays);
    records.push({ id: uid(), menuId: menu.id, name: menu.name, date, note, nutrition: lastNutrition, createdAt: Date.now() });
    persist();

    // 폼 리셋 (이름/메모/영양만, 날짜는 오늘로)
    e.target.reset();
    $('#f-date').value = todayStr();
    hideNutrition();
    lastNutrition = null;
    renderAll();
    toast(`"${menu.name}" 기록 완료! ✅`);
  });

  // 기록 삭제 (이벤트 위임)
  $('#recent-list').addEventListener('click', (e) => {
    const id = e.target.closest('[data-del-record]')?.dataset.delRecord;
    if (!id) return;
    records = records.filter((r) => r.id !== id);
    persist();
    renderAll();
  });
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
  $('#menu-list').addEventListener('change', (e) => {
    const id = e.target.dataset.menuCd;
    if (!id) return;
    const m = getMenu(id);
    if (m) { m.cooldownDays = Math.max(0, parseInt(e.target.value, 10) || 0); persist(); renderCooldownTab(); }
  });
  // 메뉴 삭제
  $('#menu-list').addEventListener('click', (e) => {
    const id = e.target.closest('[data-del-menu]')?.dataset.delMenu;
    if (!id) return;
    const m = getMenu(id);
    const cnt = records.filter((r) => r.menuId === id).length;
    if (!confirm(`"${m?.name}" 메뉴와 관련 기록 ${cnt}개를 삭제할까요?`)) return;
    menus = menus.filter((x) => x.id !== id);
    records = records.filter((r) => r.menuId !== id);
    persist();
    renderAll();
  });

  // 설정
  $('#set-default-cooldown').addEventListener('change', (e) => {
    settings.defaultCooldownDays = Math.max(0, parseInt(e.target.value, 10) || 0);
    persist();
  });
  $('#set-provider').addEventListener('change', (e) => {
    settings.llmProvider = e.target.value;
    persist();
    renderProviderConfig();
  });
  $('#set-key').addEventListener('change', (e) => {
    if (settings.llmProvider !== 'mock') { settings.keys[settings.llmProvider] = e.target.value.trim(); persist(); }
  });
  $('#set-model').addEventListener('change', (e) => {
    if (settings.llmProvider !== 'mock') { settings.models[settings.llmProvider] = e.target.value.trim(); persist(); }
  });

  // 데이터 내보내기/가져오기/삭제
  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ menus, records, settings, exportedAt: todayStr() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cooldown-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (Array.isArray(data.menus)) menus = data.menus;
        if (Array.isArray(data.records)) records = data.records;
        if (data.settings) settings = Object.assign(settings, data.settings);
        persist();
        renderAll();
        toast('가져오기 완료! 📥');
      } catch { toast('파일을 읽을 수 없어요.'); }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('모든 기록과 메뉴를 삭제할까요? 되돌릴 수 없습니다.')) return;
    menus = []; records = [];
    persist();
    renderAll();
    toast('전체 삭제 완료');
  });
}

/* ---------- 시작 ---------- */
initTabs();
initRecordForm();
initManage();
renderAll();
