# 🍢 쿨타임 트래커

먹거나 한 것을 기록하고, **항목별 쿨타임(다시 해도 되는 날)** 까지 남은 기간을 카운트다운해 주는 웹앱.
예) "떡볶이 = 30일 쿨타임" → 먹은 날로부터 30일이 지나야 "먹어도 OK".

**v2부터 계정 기반입니다** — 이메일로 가입/로그인하면 기록이 본인 계정(Supabase)에 저장되어
어느 기기·브라우저에서든 이어서 쓸 수 있어요.

## 기능

| 기능 | 설명 |
|---|---|
| 🔐 계정 | 이메일 회원가입(+인증 메일), 로그인, 비밀번호 찾기/변경, 회원 탈퇴 |
| 📝 기록 | 메뉴 이름·날짜·메모 입력. 새 이름이면 메뉴가 자동 생성됨 |
| 📷 사진 인식 | 사진 촬영/선택 → 메뉴명 자동 채움. 음식 접시(AI 비전) 또는 메뉴판·영수증 글자(기기 내 OCR) |
| 🤖 AI 영양분석 | 칼로리·영양성분·건강코멘트·권장 쿨타임 자동 채움 (기본=무료 데모) |
| ⚙️ 쿨타임 등록 | 메뉴별 쿨타임(일) 설정·수정, 계정별 기본 쿨타임 |
| ⏳ 쿨타임 VIEW | 마지막 기록일 기준 남은 일수·다음 가능일·진행바, "지금 OK / 쿨타임 중" 분류 |
| 🎉 인앱 알림 | 접속 시 그 사이 쿨타임이 끝난 항목을 toast + "새로 완료" 배지로 알림 |
| 💾 데이터 | JSON 내보내기·가져오기, 전체 삭제. v1(로컬 저장) 기록은 첫 로그인 때 이관 제안 |

## 실행 방법

```
python -m http.server 5500
```
접속: http://localhost:5500

> ⚠️ 이제 `index.html` 더블클릭(`file://`)은 권장하지 않아요 — 인증 메일의 링크가
> `http(s)://` 주소로만 돌아올 수 있기 때문입니다. 로컬 서버나 GitHub Pages로 여세요.

## 최초 1회 — Supabase 셋업 가이드 (무료)

이 앱은 [Supabase](https://supabase.com) 무료 티어를 백엔드로 씁니다. 카드 등록 없이 시작할 수 있어요.

1. https://supabase.com 가입 → **New project** 생성 (리전: Northeast Asia 권장)
2. 왼쪽 **SQL Editor** → 이 저장소의 [`supabase-schema.sql`](supabase-schema.sql) 내용 전체를 붙여넣고 **Run**
   (테이블 + 행 단위 보안(RLS) + 가입 트리거 + 탈퇴 함수가 만들어집니다)
3. **Authentication > URL Configuration** → Site URL에 `http://localhost:5500` 입력
   (GitHub Pages로 배포하면 그 주소를 Redirect URLs에 추가)
4. **Settings > API** → **Project URL**과 **anon public** 키 복사
5. [`config.js`](config.js)에 붙여넣기:
   ```js
   window.COOLTIME_CONFIG = {
     SUPABASE_URL: 'https://xxxx.supabase.co',
     SUPABASE_ANON_KEY: 'eyJ...',
   };
   ```

끝! 앱을 새로고침하면 로그인 화면이 나옵니다.

### 보안에 대해

- **비밀번호는 우리 DB에 저장되지 않습니다.** Supabase Auth가 bcrypt 해시로만 보관하며,
  우리 테이블(profiles/menus/records)은 회원 id(uuid)만 참조합니다.
- **anon key는 공개되어도 안전합니다** (커밋 OK). 모든 테이블에 RLS가 걸려 있어
  로그인한 본인의 행에만 접근할 수 있기 때문입니다. 단, **service_role 키는 절대 코드에 넣지 마세요.**
- **LLM API 키는 계정·서버로 전송되지 않고** 사용 중인 브라우저(localStorage)에만 저장됩니다.

### 무료 티어 참고

- DB 500MB, 월 사용자 5만 명 등 — 개인 프로젝트 규모에선 사실상 0원.
- 인증 메일은 내장 공유 SMTP로 무료지만 **시간당 발송 수 제한**(몇 통 수준)이 있어요.
  연속 가입 테스트 시 주의. (문제 되면 대시보드에서 Confirm email을 끄면 됩니다 — 역시 무료)
- **⚠️ 무료 프로젝트는 ~1주 미사용 시 일시정지**됩니다. 앱에서 "네트워크 오류"가 나면
  대시보드에서 프로젝트를 Restore 하세요(데이터는 보존됨).

## AI 공급자 연결 (선택)

기본은 **무료 데모(mock)** — 네트워크 호출 없이 로컬 추정값을 채웁니다. **비용 0원.**

실제 LLM을 쓰려면 **관리 > 설정 > AI 공급자**에서 Claude / OpenAI / Gemini 중 선택하고 본인 **API 키**를 입력하세요.
- "AI 분석" 버튼을 **누를 때만** 호출되고, **호출당 과금**됩니다.
- 키가 없으면 해당 기능만 비활성화되고 나머지는 정상 동작합니다.

### 새 LLM 어댑터 추가하기

`app.js`의 `PROVIDERS` 객체에 어댑터 하나만 추가하면 됩니다. `analyze(name)`이
`{ calories, carbs, protein, fat, sodium, healthNote, suggestedCooldownDays }` 형태를 반환하면 끝.

```js
PROVIDERS.myllm = {
  label: 'MyLLM',
  needsKey: true,
  async analyze(name) {
    const res = await fetch('https://.../v1/...', { /* ... */ });
    const data = await res.json();
    return normalizeNutrition(extractJson(data.text)); // 헬퍼 재사용
  },
};
```
그리고 `index.html`의 `#set-provider` 셀렉트에 `<option value="myllm">MyLLM</option>` 한 줄 추가.

## 파일 구조

```
index.html           # 화면 구조 (인증 화면 + 3개 탭: 기록 / 쿨타임 / 관리)
styles.css           # 스타일 (모바일 우선, 다크모드 대응)
app.js               # 인증·클라우드 데이터 계층(store)·쿨타임 계산·LLM 어댑터·렌더링
config.js            # Supabase URL + anon key (본인 프로젝트 값으로 교체)
supabase-schema.sql  # DB 스키마 + RLS — Supabase SQL Editor에서 1회 실행
.claude/launch.json  # 로컬 미리보기용 정적 서버 설정 (상위 폴더)
```

## 관리자(admin)

가입자 목록·이메일 인증 상태 확인·강제 삭제·비밀번호 리셋은 **Supabase 대시보드 > Authentication**에서
바로 처리할 수 있습니다(별도 admin 페이지 불필요). 데이터 조회는 Table Editor 사용.

## 📷 사진으로 기록 (인식 공급자)

기록 탭의 **"📷 사진으로 기록"** 버튼 → 사진을 찍거나 고르면 메뉴명을 인식해 이름 칸에 자동으로 채웁니다.
인식 방식은 **관리 > 설정 > 사진 인식 공급자**에서 고릅니다:

| 공급자 | 무엇에 | 비용 | 비고 |
|---|---|---|---|
| **데모(mock)** | 배선 확인용 | 0원 | 실제 인식 아님 |
| **기기 내 OCR (tesseract)** | 메뉴판·영수증 **글자** | 무료·오프라인 | 최초 1회 한국어 데이터(수 MB) 다운로드. 음식 접시엔 못 씀 |
| **Claude / OpenAI / Gemini 비전** | **음식 접시 인식** | 호출당 과금 (Gemini는 무료 티어 있음) | 본인 키 필요 · **사진이 외부 API로 전송됨** |

- 비전 공급자는 키를 **이 브라우저에만** 저장하고, 인식할 때만 호출됩니다(사진 저장 안 함 — 인식 후 폐기).
- 사진 처리 전 자동으로 리사이즈·압축(장변 1280px, JPEG)해서 속도·비용을 줄입니다.
- 인식 결과가 여러 개면 **후보 칩**을 눌러 고르고, 이름 칸은 항상 직접 수정할 수 있어요.
- OCR과 비전 모두 코드는 `app.js`의 `RECOGNIZERS` 어댑터에 있어, 새 공급자는 어댑터 하나만 추가하면 됩니다(영양분석 `PROVIDERS`와 동일 구조).

## 로드맵 (다음 단계 후보)

- 🔔 웹푸시 알림 — 사이트가 닫혀 있어도 "쿨타임 완료" 브라우저 알림 (pg_cron + Edge Function, 무료 가능)
- 📱 앱 전환 (PWA — iOS 웹푸시에도 필요)
- 🖼 사진 원본 보관 (Supabase Storage + RLS) — 지금은 인식 후 폐기, 원하면 추가
- 📧 이메일 요약 알림 (선택)
