# CLAUDE.md — 잠길까 (Anyang-gongmojun)

> 이 파일은 **팀원 3명의 Claude Code가 모두 읽는 공유 규칙**이다.
> 저장소: https://github.com/aki-iie/Anyang-gongmojun
> 목적: 2026 안양시 공공데이터·AI 대학생 경진대회 (제출 마감 2026-09-21)

---

## 1. 스택 (문서와 다른 부분이 있으니 반드시 확인)

R&R 문서에 **Supabase / Vue.js** 로 적혀 있으나 **실제 코드는 다르다.**
아래가 실제 구현이며, 이 기준으로 작업한다.

| 항목 | ❌ 문서 표기 | ✅ 실제 |
|---|---|---|
| 프론트엔드 | Vue.js (`.vue`) | **React 19 + TypeScript (`.tsx`)** |
| 빌드 | — | **Vite 8** |
| 백엔드 | Supabase Edge Function | **Firebase Cloud Functions (Node 22, 2nd gen)** |
| 호스팅 | — | **Firebase Hosting** (project: `jamgilkka`) |
| 지도 | — | **Leaflet 1.9.4 + VWorld WMTS** |
| LLM | OpenAI 직접 호출 | **gpt-4o-mini via OpenRouter** (서버 프록시 `/api/llm`) |

**`.vue` 파일을 새로 만들지 마라. `.tsx` 로 작업한다.**

---

## 2. 🔒 파일 소유권 — 절대 위반 금지

담당자가 아닌 파일은 **읽기만 하고 수정하지 않는다.**
수정이 필요하면 고치지 말고, 사용자에게 이렇게 안내한다:

> "이 파일은 OOO 담당입니다. 직접 수정하지 않겠습니다. 필요한 변경 내용을 정리해드릴 테니 담당자에게 전달하세요."

### 류서현 (팀장 / 웹·인프라)
```
src/**                      전체 프론트엔드
functions/index.js          엔드포인트 등록 (⚠️ 최다 충돌 지점)
functions/flood.js          침수 판정·조회
functions/geocode.js        주소→좌표
functions/flood30.json      30년 빈도 침수 데이터
functions/flood50.json      50년 빈도 침수 데이터
functions/package.json      서버 의존성
functions/extract-slot/index.ts
firebase.json               배포 설정
vite.config.ts              빌드 설정
package.json                프론트 의존성
public/**                   정적 자원 (예외: 아래 차동현 항목)
README.md
docs/schema.md
```

### 차동현 (판정 로직 / 데이터 분석)
```
scripts/diagnose.py               이중 경로 판정 순수 함수 (Python)
scripts/test_diagnose.py          단위 테스트
scripts/DS1_kmeans_clustering.ipynb
scripts/DS2_spatial_grid_analysis.ipynb
functions/diagnose.js             판정 순수 함수 (JS)
functions/extract-slot/prompt.txt 슬롯 추출 프롬프트
public/assets/data/**             분석 산출 데이터셋·이미지
docs/DS3_evaluation.md
docs/final_submission/**
```

### 김황현 (현장 데이터 / 정책 문서)
```
field_survey_45.csv
docs/assets/field_photos/**
docs/paper/**
```

### 공용 (수정 전 반드시 카톡 공지)
```
CLAUDE.md    이 파일
.gitignore
```

---

## 3. 경계 규칙 (충돌 사고의 90%가 여기서 난다)

### `functions/index.js` 는 류서현만 만진다
차동현은 **순수 함수만** 내보낸다. 서버에 붙이는 일은 하지 않는다.

```js
// functions/diagnose.js  ← 차동현이 여기까지만
function diagnose(slots) { /* ... */ }
module.exports = { diagnose };
```

```js
// functions/index.js     ← 류서현이 여기를 담당
const { diagnose } = require('./diagnose');
// onRequest 등록, CORS, region 설정 등
```

Claude가 `diagnose.js` 작업 중 "엔드포인트도 등록해드릴까요?" 하고 `index.js` 를 여는 순간 충돌이다. **하지 마라.**

### 결과 화면 문구는 `src/content.ts` 에 있다
김황현이 행동요령·정책 처방 문구를 담당하지만, **파일은 류서현이 관리**한다.
김황현은 텍스트만 카톡으로 전달하고, 반영은 류서현이 한다.

### 데이터 파일은 소유자만 덮어쓴다
`functions/flood30.json`, `flood50.json` 은 파이썬 파이프라인 산출물이다.
직접 편집하지 말고, 재생성이 필요하면 담당자에게 요청한다.

---

## 4. Claude 작업 시 금지 사항

- ❌ **요청하지 않은 리팩터링** — import 정리, 포맷 통일, 주석 보강, 변수명 개선
  한 줄 고치라는 요청에 diff 200줄이 나오면 git 은 그걸 전부 충돌로 본다.
- ❌ **"겸사겸사" 수정** — 담당 아닌 파일을 편의상 함께 고치는 것
- ❌ **의존성 임의 추가** — `package.json` 에 패키지를 넣기 전에 담당자 확인
- ❌ **`.env` 읽기/열기** — 로그·출력·에러에 키가 노출되지 않게 한다
- ❌ **시크릿 하드코딩**
- ❌ **`.vue` 파일 생성** — 이 프로젝트는 React 다

**수정 범위는 요청받은 최소한으로 유지한다.** 충돌 면적이 곧 사고 확률이다.

---

## 5. git 규칙

### 작업 전
남의 담당 파일을 만져야 하면 **만지기 전에** 카톡 한 줄.
> "나 지금부터 functions/index.js 만짐"

### 커밋 메시지
```
영역: 무엇을 했는지
```
예시:
```
functions: 침수흔적도 판정 로직 추가
src: 결과 카드 경로 A/B 분리 표기
scripts: K-Means 군집 4개로 조정
docs: 3p 현장 실태조사 초안 작성
```

무엇을 언제 누가 고쳤는지는 **커밋 이력이 전부 기록한다.**
변경 내역을 적는 별도 문서를 새로 만들지 마라.

### push 전
```bash
git pull --rebase origin main
```
충돌이 나면 혼자 해결하지 말고 해당 파일 담당자에게 연락한다.

### README 갱신 시점
파일이 새로 생기거나 폴더 구조가 바뀔 때만 `README.md` 의 파일 구조 표를 고친다.
코드 한 줄 고칠 때마다 건드리는 문서가 아니다.

---

## 6. 개발 / 배포 명령

```bash
npm run dev            # 로컬 개발 서버
npm run build          # 프로덕션 빌드
npm run lint           # ESLint (0 errors 0 warnings 유지)
firebase deploy        # 전체 배포
firebase deploy --only hosting    # 프론트만
firebase deploy --only functions  # 서버만
```

배포는 **류서현만** 수행한다.

---

## 7. 프로젝트 구조

```
src/
  App.tsx           4단계 화면 상태머신 (진입 → 주소 → 사진 → 결과)
  content.ts        ★ 질문·선택지·점수·문구 — 텍스트 수정은 대부분 여기
  FloodMap.tsx      Leaflet 지도 (2단계: 깨끗한 지도 → 침수 오버레이)
  RainCanvas.tsx    배경 연출
  sync/
    address.ts      Daum 우편번호 + VWorld 지오코딩
    flood.ts        GPS/URL 좌표 처리, 침수 조회
    openai.ts       LLM 호출 (Vision / 매핑 / 대화)

functions/
  index.js          엔드포인트 3종 등록 (llm, flood, geocode)
  flood.js          점-in-폴리곤 판정, 주변 도형 반환
  geocode.js        VWorld 지오코더 (region: asia-northeast3)
  flood30.json      30년 빈도 도시침수지도
  flood50.json      50년 빈도 도시침수지도
```

---

## 8. 알려진 제약

- `SEG_CODE N330~N334` = 침수심 등급 (클수록 깊음). **실제 미터 범위는 미확인.**
- VWorld 지오코더는 **해외 IP를 차단**한다. `geocode` 함수는 반드시 `asia-northeast3` 리전.
- 진단 1회 비용 약 **9원** (사진 3장 Vision 호출 포함).
- 충훈동은 도시침수지도 범위 **밖**이다. 침수흔적도(별도 채널)로 보완 예정.

---

**최종 수정**: 2026-09-06 / 류서현
