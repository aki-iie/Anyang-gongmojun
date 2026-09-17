# DB 스키마 — 판정 결과 ↔ Firestore

작성 2026-09-16 · 류서현 · Firebase 프로젝트 `jamgilkka` · Firestore 리전 `asia-northeast3`

## 컬렉션을 둘로 나눈 이유

기준은 **위험 등급이 아니라 동의 여부**다. 등급으로 컬렉션을 나누면 판정 기준을 손볼
때마다 문서를 옮겨야 하고, 전체 집계를 하려면 여러 컬렉션을 합쳐야 한다. 등급은
`level` **필드**로 두고 쿼리로 거른다.

| 컬렉션 | 무엇 | 동의 | 위치 정보 |
|---|---|---|---|
| `diagnoses` | 지원 접수한 건 | 필수 (수집·이용 + 제3자 제공) | 도로명주소 + 상세주소 + 정확 좌표 |
| `stats` | 진단을 끝낸 **모든** 건 | 불필요 (익명) | 100m 격자 + 구(區)만 |

`stats` 가 필요한 이유는 대조군이다. 위험 판정만 모아두면 "위험한 집만 모아놓고
위험하다고 한 것"이 되어 판정이 실제로 갈라지는지 보일 수 없다. 안전으로 나온 집의
분포가 있어야 검증이 성립한다.

## `level` — 표시용 파생값 (판정 아님)

엔진(`src/utils/diagnose.ts`, `scripts/diagnose.py`)은 **일부러 단일 점수를 만들지
않는다.** 경로 A(지표 유입)와 경로 B(역류)는 막는 설비가 달라서 따로 판정한다.
`level` 은 분류·집계를 위해 서버가 두 상태에서 파생시킨 라벨일 뿐이고, 판정 근거로
인용하면 안 된다. 규칙은 `functions/save.js` 의 `levelOf()` 한 곳에만 있다.

```
위험      surface === '유입가능'  또는  backflow === '매우미흡'
주의      backflow === '미흡'
확인필요  둘 중 하나라도 '확인필요'
안전      surface === '방어가능'  이면서  backflow === '양호'
```

**확인필요를 안전에 섞지 않는다.** 모르는 것을 안전으로 분류하면 "저기는 괜찮다더라"가
되어 버린다. 이건 엔진이 `uncertain` 을 다루는 원칙과 같다.

기존 `needsSupport`(접수 버튼 노출 조건)는 `위험 ∪ 주의` 와 정확히 같다.

## `diagnoses` — 지원 접수

동의 2건 + 위험 판정(`위험`/`주의`) + 안양시 좌표, 세 가지를 **서버가 다시 검사**한
뒤에만 기록한다. 클라이언트가 보낸 값을 그대로 믿으면 위조 요청으로 대시보드에
쓰레기가 쌓인다.

```ts
diagnoses/{docId}
{
  location: { lat, lon, address, detail, district: '만안구'|'동안구'|null,
              dong: '충훈동'|…|null, dongCode: '4117161100'|null },
  flood:    { covered, inMap, seg, predCm, traceCm, depthCm, basis },
  slots:    { entrance_sill: '없음', ... },       // 답한 12슬롯만
  diagnosis: {
    surface:  { status, reason, effectiveDefenseCm, weakestPoint, needBarrierCm, unknownOpenings },
    backflow: { status, signals, signalCount, experienced },
    warnings: string[],
    actions:  string[],                           // 항목명만
    quality:  { unknownCount, totalSlots, reliable }
  },
  level: '위험'|'주의'|'확인필요'|'안전',          // 서버 파생
  consent: { provide: true, priority: true },
  status: '미확인'|'확인중'|'지원연계완료',
  ticket: 'AY-######',                            // 서버 발급, 사용자 화면에 표시
  createdAt
}
```

## `stats` — 익명 통계

진단 결과 화면에 도달하면 자동으로 한 건 남는다(동의 불필요). **개인을 식별할 수 있는
값은 넣지 않는다** — 주소도, 상세주소도, 정확한 좌표도 저장하지 않는다. 좌표는 서버가
100m 격자로 바꾼 뒤 원본을 버린다. 격자 크기는 `scripts/DS2_spatial_grid_analysis.ipynb`
의 `CELL_M = 100` 과 같게 맞췄다 — 나중에 격자별 분포를 지도에 그대로 올릴 수 있다.

```ts
stats/{docId}
{
  level, surface, backflow,                        // 판정 결과
  grid: { id: '100m_41507_112281', lat, lon, cellM: 100 } | null,   // 셀 중심 좌표
  dong, dongCode,                                  // 행정동 (수천 세대 단위라 식별정보 아님)
  district: '만안구'|'동안구'|null,
  depthCm, predCm, traceCm, basis, inMap, covered,
  slots: { ... },                                  // 집 구조 답변 (식별 불가)
  unknownCount, reliable,
  createdAt
}
```

주소는 요청 본문으로 잠깐 올라오지만 구(區)만 뽑고 버린다 — 저장되지 않는다.
여유를 더 두고 싶으면 `functions/save.js` 의 `CELL_M` 만 키우면 된다(250m 등).

## 동의 절차

문구는 `src/content.ts` 의 `CONSENT` 한 곳에서만 고친다. 개인정보보호법이 요구하는
네 가지를 모두 화면에 띄운다 — 수집 항목, 수집·이용 목적, 보유·이용 기간, 거부 권리와
그에 따른 불이익. 체크박스는 [필수] 2개(수집·이용 / 제3자 제공)에 전체동의 하나.

`stats` 는 동의 대상이 아니라 **고지** 대상이다. 수집 전에 알려야 하므로 주소 입력
단계와 촬영 안내에 `STATS_NOTE` 를 띄우고, 결과 화면에서 다시 한 번 알린다.

보유·이용 기간은 **접수일로부터 1년**으로 확정했다(2026-09-16, 팀 결정). 바꿔야 하면
`src/content.ts` 의 `CONSENT.table` 한 줄만 고치면 화면과 문서가 같이 따라간다.

## 코드 위치

| 파일 | 역할 |
|---|---|
| `functions/save.js` | 검증 · `levelOf` · `gridOf` · 두 컬렉션 쓰기 · 접수번호 발급 |
| `functions/index.js` | `exports.save`, `exports.stats` 등록 (asia-northeast3) |
| `src/sync/save.ts` | `/api/save`, `/api/stats` 호출, payload 구성 |
| `src/App.tsx` | 결과 도달 시 통계 1회 기록, 동의 모달 → 접수 |
| `src/content.ts` | `CONSENT`, `STATS_NOTE` 문구 |
| `functions/dong.js` | 좌표 → 행정동 판정 (점-in-폴리곤) |
| `tools/build_dong.py` | 경계 원자료 → `functions/dong.json` · `public/dong.json` |
| `firestore.rules` | 클라이언트 쓰기 전면 차단, 두 컬렉션 모두 admin 만 읽기 |

- `POST /api/save` → `201 { saved, ticket }` / 조건 미달 `400 { error }` (문구가 그대로 모달에 뜬다)
- `POST /api/stats` → `201 { recorded, level }`. 실패해도 화면을 막지 않는다.

## 알려진 한계

- **행정동은 좌표로 판정한다.** `functions/dong.js` 가 `functions/dong.json`(안양시 행정동 31개
  경계, 21KB)에 점-in-폴리곤을 돌린다. 지오코더를 한 번 더 부르지 않고, 주소가 없는 GPS 경로에서도
  채워진다. 원자료는 통계청 SGIS(공공누리 1유형) → `vuski/admdongkor`(CC BY 4.0), 재생성은
  `tools/build_dong.py`. **법정동이 아니라 행정동이다** — 충훈동은 법정동으로는 없지만 행정동으로는
  실재하며(옛 석수3동), 침수흔적 5건이 정확히 이 동에 떨어진다.
- **슬롯 값 검증이 느슨하다.** `save.js` 는 12개 키만 걸러내고 값은 길이만 본다. enum
  단일 원천이 TS(`functions/src/prompt.ts`)라 런타임 JS 가 못 읽는다. 명세가 바뀌었을 때
  저장이 조용히 막히는 쪽이 더 위험하다고 보고 느슨하게 뒀다.
- **접수번호가 랜덤 6자리다.** 수백 건에선 충돌이 사실상 없지만, 완전히 막으려면
  카운터 문서를 두거나 docId 를 쓰면 된다.
- **중복 기록.** 같은 사람이 두 번 진단하면 `stats` 에 두 건이 남는다. 세션 단위
  중복 제거는 하지 않았다 — 집계에서 격자별로 보면 큰 문제가 아니다.
- **관리자 대시보드(`/admin`)가 없다.** 지금은 Firebase 콘솔에서 본다. 규칙상 읽기는
  `admin: true` 커스텀 클레임 계정만 되므로 대시보드를 붙일 때 계정 발급이 같이 필요하다.

## 배포

```bash
npm run build
firebase deploy --only firestore:rules,functions,hosting
```
