# ⚠️ 폐기 — 적용하지 마십시오

> **판정: 적용하지 않는다** (인수인계 §6, 류서현)
> 이 문서는 **전제가 사라진 지시서**입니다. 이력 참고용으로만 남깁니다.

**왜 폐기되었나**

| 이 문서의 전제 | 현재 (`0d8c1d9` 이후) |
|---|---|
| 100점 총점 체계를 유지한다 | **점수 체계가 없다.** `content.ts` 에 `SUPPORT_THRESHOLD`·`levelOf`·배점이 전부 없다 |
| 문진 3문항에 2문항을 더한다 | **12슬롯으로 마이그레이션됐다** (`scripts/diagnose.py` `ALLOWED`) |
| 역류 문항 2개를 새로 넣는다 | 역류는 이미 **4슬롯**(`backflow_valve`·`rainy_symptom`·`gurgling`·`floor_backup`)으로 판정한다 |
| 대시보드 링크를 붙인다 | 대시보드가 진단 결과를 읽는 구조로 재설계 대기 중 (인수인계 §9 #7) |

**즉 여기 제안된 2문항 역류 카드는 현재의 4슬롯 역류 판정보다 약합니다.** 적용하면 퇴행입니다.

원인은 작성 시점의 정보 격차입니다 — 12슬롯 마이그레이션이 푸시되지 않은 상태에서
낡은 `origin/main` 을 기준으로 작성됐습니다 (인수인계 §6·§10).

**대신 볼 것**: 현재 판정 규격은 `scripts/diagnose.py`, 저장 스키마는 `docs/schema.md`.

---

# (이하 원문 — 폐기됨)

# 류서현 연동 지시서 — 역류 카드 + 대시보드

> 작성 2026-09-17 · 차동현
> 목적: **100점 총점 체계를 그대로 두고** 결과 화면에 카드 하나, 문항 두 개, 링크 하나를 얹는다.
> 예상 작업량: 2~3시간. `src/App.tsx` · `src/content.ts` 두 파일만 손댄다.

---

## 0. 왜 이렇게 가는가

이중 경로(지표 유입 / 역류)로 판정 체계를 갈아엎는 건 4일 안에 위험하다.
대신 **역류 대비 상태**를 별도 카드로 얹으면:

- 총점 로직 안 건드림 → 기존 화면·지도·대화 전부 그대로
- "안양시는 물막이판 미지원, 역류방지밸브 미지원"이라는 정책 논거가 **제품 화면에 등장**
- 사업계획서 4·8·9페이지의 이중 경로 서사가 유효해짐

---

## 1. `src/content.ts` — 문항 2개 추가

`QUESTIONS` 배열 **맨 뒤**에 아래 두 항목을 추가한다.
`history` 다음 순서. 기존 3문항은 건드리지 않는다.

```ts
{
  key: 'valve',
  photo: 2,   // 골목 사진 재표시 (역류는 사진으로 판단 불가, 문답 전용)
  text: '집 안 배수구에 역류방지밸브가 설치되어 있나요? 하수구 뚜껑을 열면 물이 거꾸로 못 올라오게 막는 장치예요.',
  ack: '알겠어요. 하나만 더 여쭤볼게요.',
  options: [
    ['있어요', 0],
    ['없어요', 0],
    ['잘 모르겠어요', 0],
  ],
},
{
  key: 'rainy',
  photo: 2,
  text: '비가 많이 오는 날에 화장실 물이 잘 안 내려가거나, 하수구 냄새가 올라온 적이 있나요?',
  ack: '',
  options: [
    ['그런 적 있어요', 0],
    ['없어요', 0],
    ['잘 모르겠어요', 0],
  ],
},
```

**점수는 전부 0.** 이 두 문항은 총점에 들어가지 않는다. 역류 카드에만 쓴다.

같은 파일에서 타입과 이름표를 갱신한다.

```ts
export type QuestionKey = 'sill' | 'window' | 'history' | 'valve' | 'rainy';

export const FACTOR_NAMES: Record<QuestionKey, string> = {
  sill: '현관 턱 높이',
  window: '창문 아래쪽 높이',
  history: '골목 침수 이력 (2022년 8월)',
  valve: '역류방지밸브',
  rainy: '강우 시 배수 증상',
};
```

`SLOTS` 는 사진 슬롯이므로 그대로 둔다.

---

## 2. `src/App.tsx` — 역류 카드

### 2.1 import 추가

```ts
import { diagnoseBackflowOnly, backflowAdvice } from './utils/diagnose';
```

### 2.2 답변 라벨 → Enum 변환

`scores` 는 점수만 담고 있어서 어떤 보기를 골랐는지 모른다.
이미 `labels` state 가 있으니 (`setLabels`) 그걸 쓴다. 없으면 `commitAnswer` 에서 보기 문구를 저장하도록 한 줄 추가.

```ts
/* 역류 문항의 보기 문구 → 판정 엔진 Enum */
const toYesNo = (label?: string): '있음' | '없음' | 'unknown' => {
  if (!label) return 'unknown';
  if (label.startsWith('있어요') || label.startsWith('그런 적')) return '있음';
  if (label.startsWith('없어요')) return '없음';
  return 'unknown';
};

const backflow = diagnoseBackflowOnly({
  backflow_valve: toYesNo(labels.valve),
  rainy_symptom: toYesNo(labels.rainy),
});
const bfAdvice = backflowAdvice(backflow);
```

`score` 계산하는 줄(392행 부근) 바로 아래에 두면 된다.

### 2.3 결과 화면에 카드 삽입

총점 카드와 대비책 목록 **사이**에 넣는다. 스타일은 기존 `css()` 헬퍼 그대로.

```tsx
{/* ── 역류 대비 상태 — 총점과 별도. 물막이판으로 막을 수 없는 경로 ── */}
<section style={css('margin-top:28px;padding:20px;border:1px solid var(--color-neutral-300);border-radius:12px')}>
  <div style={css('display:flex;align-items:baseline;gap:10px;margin-bottom:8px')}>
    <span style={css('font-size:17px;font-weight:600')}>역류 대비 상태</span>
    <span style={css(
      'font-size:14px;font-weight:600;padding:2px 10px;border-radius:999px;' +
      (backflow.status === '매우미흡' ? 'background:#fde8e8;color:#b91c1c'
       : backflow.status === '미흡'   ? 'background:#fff4e0;color:#b45309'
       : backflow.status === '양호'   ? 'background:#e8f5ee;color:#15803d'
       :                                'background:#eef0f3;color:#4b5563')
    )}>{backflow.status}</span>
  </div>

  <p style={css('margin:0 0 10px;font-size:15px;color:var(--color-neutral-700)')}>
    위 점수는 <b>밖에서 들어오는 물</b>에 대한 것입니다.
    하수관이 넘쳐 변기·배수구로 <b>거꾸로 올라오는 물</b>은 물막이판으로 막을 수 없습니다.
  </p>

  {backflow.signals.length > 0 && (
    <ul style={css('margin:0 0 10px;padding-left:18px;font-size:15px')}>
      {backflow.signals.map((s, i) => <li key={i}>{s}</li>)}
    </ul>
  )}

  {backflow.status === '확인필요' && (
    <p style={css('margin:0;font-size:14px;color:var(--color-neutral-600)')}>
      역류방지밸브 유무와 비 오는 날 배수 증상을 확인하면 판정할 수 있어요.
    </p>
  )}

  {bfAdvice && (
    <div style={css('margin-top:12px;padding:12px 14px;background:var(--color-neutral-100);border-radius:8px')}>
      <div style={css('font-weight:600;margin-bottom:4px')}>{bfAdvice.title}</div>
      <div style={css('font-size:14px;margin-bottom:6px')}>{bfAdvice.body}</div>
      <div style={css('font-size:13px;color:#b91c1c')}>{bfAdvice.support}</div>
    </div>
  )}
</section>
```

### 2.4 후속 대화 컨텍스트에 역류 상태 포함

`resultSummary` 문자열(452행 부근)에 한 줄 추가하면 챗봇이 역류 질문에도 답한다.

```ts
resultSummary: `총점 ${score}점 / 100 · 위험 등급 "${level}"
역류 대비 상태: ${backflow.status}${backflow.signals.length ? ' — ' + backflow.signals.join(' / ') : ''}
점수는 높을수록 ...`,
```

---

## 3. 대시보드 링크

`public/assets/data/dashboard.html` 은 **빌드 없이 그대로 서빙**된다.
Firebase Hosting 이 `public/` 을 그대로 올리므로 배포 후 이 주소로 열린다.

```
https://jamgilkka.web.app/assets/data/dashboard.html
```

결과 화면 하단이나 푸터에 링크 하나만 추가한다.

```tsx
<a href="/assets/data/dashboard.html" target="_blank" rel="noopener"
   style={css('font-size:13px;color:var(--color-neutral-600)')}>
  행정용 대시보드 (시범) ↗
</a>
```

`/admin` 라우트로 붙이고 싶으면 `firebase.json` rewrites 에 한 줄:

```json
{ "source": "/admin", "destination": "/assets/data/dashboard.html" }
```

---

## 4. 확인 순서

1. `npm run dev` → 문진이 **5문항**으로 늘었는지
2. 4·5번 문항에 `있어요/없어요/잘 모르겠어요` 답하고 결과 화면 진입
3. 총점은 **기존과 동일**한지 (역류 문항 점수 0)
4. 총점 카드 아래 **역류 대비 상태** 카드가 뜨는지
5. 밸브 `없어요` + 증상 `있어요` → 상태 **미흡**, 조치 안내에 "안양시는 역류방지밸브 지원 품목이 아닙니다" 문구
6. 둘 다 `잘 모르겠어요` → 상태 **확인필요**
7. `npm run lint` → 0 errors
8. `/assets/data/dashboard.html` 열어서 표와 히트맵 뜨는지

---

## 5. 타임아웃 폴백 — 이건 류서현 영역이지만 꼭

`src/sync/openai.ts` 의 `fetch` 에 `AbortController` 8초.
실패하면 `normalizeVLM` 기본값으로 떨어지게 이미 돼 있으니, **타임아웃만 걸면 된다.**

```ts
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 8000);
try {
  const r = await fetch(url, { ...opts, signal: ctrl.signal });
  ...
} finally {
  clearTimeout(timer);
}
```

시연 중 OpenRouter 가 10초 넘게 걸리면 화면이 멈춘다. 이게 완성도 20점을 지킨다.

---

## 6. 하지 말 것

- 총점 산식 변경 ✗
- 기존 3문항 문구·점수 변경 ✗
- `diagnose()` 전체 함수 호출 ✗ — `diagnoseBackflowOnly()` 만 쓴다
- `levelOf()` 경계 변경 ✗

**변경 면적을 최소로.** 역류 카드는 기존 결과에 *덧붙는* 것이지 *대체하는* 것이 아니다.
