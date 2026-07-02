# 🍢 쿨타임 트래커

먹거나 한 것을 기록하고, **항목별 쿨타임(다시 해도 되는 날)** 까지 남은 기간을 카운트다운해 주는 웹앱.
예) "떡볶이 = 30일 쿨타임" → 먹은 날로부터 30일이 지나야 "먹어도 OK".

## 실행 방법

설치·빌드 필요 없음. 두 가지 중 편한 방법으로:

1. **그냥 열기** — `index.html` 더블클릭 (브라우저에서 바로 실행)
2. **로컬 서버로 보기** — Python이 있으면:
   ```
   python -m http.server 5500
   ```
   접속: http://localhost:5500

> 데이터는 **브라우저(localStorage)에만** 저장됩니다. 서버로 전송되지 않아요.
> 단, `file://`(더블클릭)과 `http://localhost`는 저장 공간이 분리됩니다. 기록을 옮기려면 **관리 > 내보내기/가져오기(JSON)** 사용.

## 기능

| 기능 | 설명 |
|---|---|
| 📝 기록 | 메뉴 이름·날짜·메모 입력. 새 이름이면 메뉴가 자동 생성됨 |
| 🤖 AI 영양분석 | 칼로리·영양성분·건강코멘트·권장 쿨타임 자동 채움 (기본=무료 데모) |
| ⚙️ 쿨타임 등록 | 메뉴별 쿨타임(일) 설정·수정 |
| ⏳ 쿨타임 VIEW | 마지막 기록일 기준 남은 일수·다음 가능일·진행바, "지금 OK / 쿨타임 중" 분류 |
| 💾 데이터 | JSON 내보내기·가져오기, 전체 삭제 |

## AI 공급자 연결 (선택)

기본은 **무료 데모(mock)** — 네트워크 호출 없이 로컬 추정값을 채웁니다. **비용 0원.**

실제 LLM을 쓰려면 **관리 > 설정 > AI 공급자**에서 Claude / OpenAI / Gemini 중 선택하고 본인 **API 키**를 입력하세요.
- "AI 분석" 버튼을 **누를 때만** 호출되고, **호출당 과금**됩니다(키는 이 브라우저에만 저장).
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
index.html    # 화면 구조 (3개 탭: 기록 / 쿨타임 / 관리)
styles.css    # 스타일 (모바일 우선, 다크모드 대응)
app.js        # 저장·쿨타임 계산·LLM 어댑터·렌더링 전부
.claude/launch.json  # 로컬 미리보기용 정적 서버 설정
```

## 로드맵 (다음 단계 후보)

- 📷 사진 촬영 → OCR로 메뉴 자동 인식 (현재 버튼 자리만 마련됨)
- 🔔 쿨타임 임박 알람 (브라우저 알림 → 추후 앱 푸시)
- 📱 앱 전환 (PWA 또는 Capacitor/React Native)
- ☁️ 계정·동기화 (여러 기기에서 공유하려면 백엔드 필요)
