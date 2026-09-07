# 류서현 담당 범위

> 역할: **팀장 / 웹·UI·인프라 총괄**
> 저장소: https://github.com/aki-iie/Anyang-gongmojun
> 제출 마감: **2026-09-21** (작성일 2026-09-06 기준 **D-15**)
> 파일 소유권 전체 표는 루트 `CLAUDE.md` 참조

---

## 1. 내가 소유한 파일 (다른 사람 수정 금지)

### 프론트엔드
| 파일 | 역할 | 상태 |
|---|---|---|
| `src/App.tsx` | 4단계 화면 상태머신 | ✅ 동작 |
| `src/content.ts` | ★ 질문·선택지·점수·결과 문구 | ⚠️ 3문항 (계획은 12) |
| `src/FloodMap.tsx` | Leaflet 지도, 2단계 연출 | ✅ 동작 |
| `src/RainCanvas.tsx` | 배경 연출 | ✅ 동작 |
| `src/sync/address.ts` | Daum 우편번호 + VWorld 지오코딩 | ✅ 동작 |
| `src/sync/flood.ts` | GPS·URL 좌표 처리, 침수 조회 | ✅ 동작 |
| `src/sync/openai.ts` | LLM 호출 (Vision·매핑·대화) | ⚠️ 타임아웃 폴백 없음 |
| `src/*.css`, `src/css.ts` | 스타일 | ✅ 동작 |

### 서버 (Firebase Functions)
| 파일 | 역할 | 상태 |
|---|---|---|
| `functions/index.js` | ⚠️ **엔드포인트 등록 — 최다 충돌 지점** | ✅ 3종 배포됨 |
| `functions/flood.js` | 두 채널 판정(예측+실적), 주변 도형 | ✅ 동작 |
| `functions/geocode.js` | VWorld 지오코더 (asia-northeast3) | ✅ 동작 |
| `functions/flood30.json` | 30년 빈도 도시침수지도 | ✅ 적재 |
| `functions/flood50.json` | 50년 빈도 도시침수지도 | ✅ 적재 |
| `functions/trace.json` | 침수흔적도 8건 (석수동5·박달동1·비산동2) | ✅ 적재 |
| `tools/build_trace.py` | 흔적도 재생성 스크립트 | ✅ 동작 |
| `functions/package.json` | 서버 의존성 | ✅ |

### 설정·배포
| 파일 | 상태 |
|---|---|
| `firebase.json` | ✅ Hosting + Functions |
| `vite.config.ts` | ✅ |
| `package.json` | ✅ |
| `.env` / `functions/.env` | ✅ (git 제외됨) |
| `README.md` | ✅ 최신 |
| `docs/schema.md` | ❌ **미작성** |

### 아직 없는 내 파일 (만들어야 함)
```
src/views/AdminDashboard.tsx      공무원용 대시보드 (/admin)
functions/extract-slot/index.ts   슬롯 추출 LLM 호출
docs/schema.md                    12슬롯 ↔ DB 컬럼 매핑
```

---

## 2. 내 업무 4개 — 현재 상태

### ① 화면 개발
- [x] 진입 화면
- [x] 주소 입력 (Daum 우편번호 + GPS + URL 좌표, 3방식)
- [x] 사진 3장 업로드 + Vision 분석
- [x] 결과 화면 + 결과 화면 대화
- [x] 지도 2단계 연출 (깨끗한 지도 → 침수 오버레이)
- [x] 모바일 순서 (주소 먼저 → 사진 나중)
- [ ] **12문항 상태머신** — 현재 `content.ts` 에 **3문항**뿐 (`sill`, `window`, `history`)
- [ ] **진행률 바**
- [ ] **결과 카드 경로 A/B 분리** — 지표 유입 / 역류 구분 표기 없음
- [ ] **관리자 대시보드 `/admin`** — 통계 카드, 유형별 필터, CSV 다운로드

### ② API 연동 + 배포
- [x] 주소 → 좌표 변환 (VWorld)
- [x] 침수심 조회 (도시침수지도 30년·50년)
- [x] Firebase Hosting + Functions 배포
- [ ] **판정 로직 연결** — 차동현의 `diagnose.js` 를 `index.js` 에 등록
- [ ] **DB 비식별 저장** — Firestore 미연동 (코드에 흔적 없음)
- [x] **침수흔적도 2채널** — 안양시 8건 통합·배포 완료 (석수동/충훈부 5건이 예측지도 밖)

### ③ LLM 연동
- [x] OpenRouter gpt-4o-mini 3종 호출 (Vision·매핑·대화)
- [x] 서버 프록시로 키 보호 (`/api/llm`)
- [ ] **Structured Output** — 현재 프롬프트 + JSON 파싱 방식
- [ ] **8초 타임아웃 → 버튼 폴백** — 미구현
- [ ] **Mock 캐싱** — 미구현 (시연 중 API 장애 대비)

### ④ 팀장 잡무
- [ ] 2~3분 시연 영상 녹화·편집
- [ ] 참가신청서 자필 서명
- [ ] 팀원 파일 충돌 관리 (`CLAUDE.md` 배포 완료)

---

## 3. 내가 **안** 하는 것

| 영역 | 담당 | 내가 할 일 |
|---|---|---|
| 판정 알고리즘 설계 | 차동현 | `diagnose.js` 를 서버에 **붙이기만** |
| 슬롯 추출 프롬프트 내용 | 차동현 | 프롬프트를 **호출하는 코드**만 |
| 데이터 분석·노트북 | 차동현 | 산출물을 화면에 **표시만** |
| 결과 화면 행동요령 문구 | 김황현 | 텍스트 받아서 `content.ts` 에 **반영만** |
| 현장 사진·실사 데이터 | 김황현 | — |
| 사업계획서 집필 | 차동현·김황현 | — |
| 제출 서류 취합 | 김황현 | 신청서 서명만 |

**남의 담당 파일을 만져야 하면 만지기 전에 카톡 한 줄.**

---

## 4. 남은 작업 우선순위 (D-15)

### 🔴 없으면 서비스가 안 굴러감
1. **판정 로직 연결** — 차동현 `diagnose.js` 받아서 `functions/index.js` 에 등록
2. **12문항 확장** — `content.ts` 3 → 12문항, 슬롯 키 차동현과 합의
3. **8초 타임아웃 + 버튼 폴백** — 시연 중 LLM 지연 시 서비스가 멈춘다

### 🟡 심사 점수에 직결
4. **결과 카드 경로 A/B 분리** — 안양시가 역류 미지원이라는 게 이 프로젝트의 핵심 논지
5. **관리자 대시보드 `/admin`** — "공공기관이 쓸 수 있다"를 보여주는 화면
6. **Firestore 비식별 저장** — 대시보드의 전제

### 🟢 있으면 좋음
7. Mock 캐싱 (시연 안전장치)
8. `docs/schema.md` 작성
10. 사진 리사이즈 (비용·속도)
11. `content.ts` `CONTACT` 전화번호 실제 값으로 교체 (현재 `031-8045-0000` 자리표시자)

### ⚫ 마감 직전
12. 시연 영상 녹화·편집
13. 참가신청서 서명

---

## 5. 차동현에게 요청해야 할 것

1. **슬롯 12개의 키 이름 확정** — `content.ts` 와 `diagnose.js` 가 같은 키를 써야 한다
2. **`diagnose.js` 를 순수 함수로** — `module.exports = { diagnose }` 까지만, `index.js` 는 건드리지 말 것
3. **입출력 형태 확정** — `diagnose(slots, floodDepth)` → 무엇이 나오는가
4. **N330~N334 실제 침수심 미터 범위** — 미확인 상태라 점수 근거가 약하다

## 6. 김황현에게 요청해야 할 것

1. **결과 화면 문구** — 위험 등급별 행동요령 텍스트 (파일 말고 카톡으로)
2. **군집별 정책 처방 문구**
3. 45가구 실사 데이터 형식 — 대시보드 표시용

---

## 7. 자주 쓰는 명령

```bash
npm run dev                        # 로컬 개발
npm run lint                       # 0 errors 0 warnings 유지
npm run build                      # 빌드
firebase deploy --only hosting     # 프론트만
firebase deploy --only functions   # 서버만
firebase deploy                    # 전체
```

배포는 나만 한다.

---

**최종 수정**: 2026-09-06
