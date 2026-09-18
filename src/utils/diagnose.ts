/**
 * 잠길까 — 이중 경로 침수 위험 판정 엔진 (TypeScript)
 *
 * scripts/diagnose.py 와 동일한 로직이다.
 * 한쪽을 수정하면 반드시 다른 쪽도 수정하고 test_diagnose.py 를 재실행할 것.
 *
 * 설계 원칙
 *  1. 외부 의존성 없는 순수 함수. 동일 입력 -> 동일 출력.
 *  2. LLM 은 슬롯 값 추출까지만. 위험 판정은 이 파일이 전담.
 *  3. 임의 배점표 없음.
 *     - 경로 A(지표 유입): 예상침수심 - 개구부 방어높이 (물리적 뺄셈)
 *     - 경로 B(역류): 확률 산출 없이 대비 장치와 전조 징후를 카운팅
 *  4. unknown 이면 추측하지 않고 판정 보류.
 *
 * 작성: 차동현
 */

// ─────────────────────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────────────────────
export type EntranceSill = '없음' | '카드보다낮음' | '카드와비슷' | '카드보다높음' | 'unknown';
export type StairCount = '0' | '1-2' | '3-4' | '5이상' | 'unknown';
export type Installed = '설치' | '미설치' | 'unknown';
export type WindowBase = '땅보다낮음' | '비슷' | '땅보다높음' | 'unknown';
export type YesNo = '있음' | '없음' | 'unknown';
export type RoadSlope = '내리막' | '평지' | '오르막' | 'unknown';
export type DrainStatus = '양호' | '막힘의심' | '없음' | 'unknown';

export interface Slots {
  entrance_sill: EntranceSill;   // 1  현관 턱 높이
  stair_count: StairCount;       // 2  하향 계단 칸수
  water_panel: Installed;        // 3  현관 물막이판        [사진 확인 지원]
  window_base: WindowBase;       // 4  창문 하단 지면 대비
  window_barrier: Installed;     // 5  창문 차수막
  backflow_valve: YesNo;         // 6  역류방지밸브          [사진 확인 지원]
  rainy_symptom: YesNo;          // 7  강우 시 배수 지연·악취
  gurgling: YesNo;               // 8  배수 시 이상음
  floor_backup: YesNo;           // 9  바닥 배수구 역류 경험
  road_slope: RoadSlope;         // 10 골목 경사
  drain_status: DrainStatus;     // 11 빗물받이 상태
  canopy: YesNo;                 // 12 현관 차양·지붕
}

export type SurfaceStatus = '유입가능' | '방어가능' | '확인필요';
export type BackflowStatus = '양호' | '미흡' | '매우미흡' | '확인필요';

export interface SurfaceResult {
  status: SurfaceStatus;
  reason: string;
  effectiveDefenseCm: number | null;
  weakestPoint: '현관' | '창문' | null;
  inflowCm: number | null;
  needBarrierCm: number | null;
  /* 확인하지 못한 개구부 이름. 비어 있지 않으면 '방어가능' 을 말할 수 없다. */
  unknownOpenings: string[];
}

export interface BackflowResult {
  status: BackflowStatus;
  signals: string[];
  signalCount: number;
  experienced: boolean;
  unknownItems: string[];
}

export interface ActionItem {
  item: string;
  detail: string;
  support: string;
}

export interface DiagnoseResult {
  floodDepthCm: number | null;
  surface: SurfaceResult;
  backflow: BackflowResult;
  warnings: string[];
  actions: ActionItem[];
  rainGuide: string[];
  quality: {
    unknownCount: number;
    totalSlots: number;
    unknownRate: number;
    reliable: boolean;
  };
}

// ─────────────────────────────────────────────────────────────
// 슬롯 정의 — functions/src/prompt.ts 와 반드시 일치시킬 것
// ─────────────────────────────────────────────────────────────
export const SLOT_IDS: (keyof Slots)[] = [
  'entrance_sill', 'stair_count', 'water_panel', 'window_base',
  'window_barrier', 'backflow_valve', 'rainy_symptom', 'gurgling',
  'floor_backup', 'road_slope', 'drain_status', 'canopy',
];

export const ALLOWED: Record<keyof Slots, string[]> = {
  entrance_sill:  ['없음', '카드1개', '카드2개', '카드3개이상', 'unknown'],
  stair_count:    ['0', '1-2', '3-4', '5이상', 'unknown'],
  water_panel:    ['설치', '미설치', 'unknown'],
  window_base:    ['땅보다낮음', '비슷', '카드1개', '카드2개', '카드3개이상', 'unknown'],
  window_barrier: ['설치', '미설치', 'unknown'],
  backflow_valve: ['있음', '없음', 'unknown'],
  rainy_symptom:  ['있음', '없음', 'unknown'],
  gurgling:       ['있음', '없음', 'unknown'],
  floor_backup:   ['있음', '없음', 'unknown'],
  road_slope:     ['내리막', '평지', '오르막', 'unknown'],
  drain_status:   ['양호', '막힘의심', '없음', 'unknown'],
  canopy:         ['있음', '없음', 'unknown'],
};

// ─────────────────────────────────────────────────────────────
// 등급 -> cm 환산
//   신용카드 긴 변 = 85.6mm. 구간 하한을 택해 위험을 과소평가하지 않는다.
// ─────────────────────────────────────────────────────────────
/* 카드 "개수" 로 묻는다. 높다/낮다로 물었을 때 충훈동 실측 34가구가
   아래 두 칸에 0가구, 위 한 칸에 20가구(62%)로 몰렸다.
   실측 현관턱 8.5 / 17 / 25.5 / 32cm — 전부 카드(8.56cm)의 정수배로 관찰됐다.
   뒤쪽 세 개는 구버전 값 — 이미 저장된 데이터를 읽기 위해 남긴다(ALLOWED 에는 없음). */
const SILL_CM: Record<string, number> = {
  '없음': 0, '카드1개': 8.5, '카드2개': 17, '카드3개이상': 25.5,
  '카드보다낮음': 5, '카드와비슷': 9, '카드보다높음': 15,
};

/* 창문은 지면보다 낮게 박힌 사례가 실재하므로 '땅보다낮음' 을 유지하고,
   지면 위쪽만 카드 개수로 나눈다. '땅보다높음' 은 구버전 값. */
const WINDOW_BASE_CM: Record<string, number> = {
  '땅보다낮음': 0, '비슷': 3,
  '카드1개': 8.5, '카드2개': 17, '카드3개이상': 25.5,
  '땅보다높음': 20,
};

const PANEL_CM = 30;    // 가정용 물막이판 일반 규격
const BARRIER_CM = 30;  // 창문 차수막 (안양시 지원 품목)

const STAIR_DEPTH_CM: Record<string, number> = {
  '0': 0, '1-2': 16, '3-4': 48, '5이상': 80,
};

const isUnknown = (v: string | null | undefined): boolean =>
  v === null || v === undefined || v === '' || v === 'unknown';

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 허용 Enum 을 벗어난 값을 반환한다. 빈 배열이면 정상. */
export function validateSlots(slots: Partial<Slots>): string[] {
  const errors: string[] = [];
  for (const sid of SLOT_IDS) {
    const v = slots[sid];
    if (v === undefined || v === null) continue;
    if (!ALLOWED[sid].includes(v as string)) {
      errors.push(`${sid}: 허용되지 않은 값 '${v}'`);
    }
  }
  return errors;
}

// ─────────────────────────────────────────────────────────────
// 경로 A — 지표 유입
//   개구부별 방어 높이를 각각 구하고 '가장 낮은 지점'을 실효 방어높이로 삼는다.
//   현관에 물막이판이 있어도 창문이 지면보다 낮으면 그쪽으로 물이 들어온다.
// ─────────────────────────────────────────────────────────────
function diagnoseSurface(
  s: Record<string, string | null>,
  floodDepthCm: number | null,
): SurfaceResult {
  let entranceDef: number | null = null;
  if (!isUnknown(s.entrance_sill)) {
    entranceDef = SILL_CM[s.entrance_sill as string];
    if (s.water_panel === '설치') entranceDef += PANEL_CM;
  }

  let windowDef: number | null = null;
  if (!isUnknown(s.window_base)) {
    windowDef = WINDOW_BASE_CM[s.window_base as string];
    if (s.window_barrier === '설치') windowDef += BARRIER_CM;
  }

  const known: Record<string, number> = {};
  if (entranceDef !== null) known['현관'] = entranceDef;
  if (windowDef !== null) known['창문'] = windowDef;
  const unknownOpenings = (['현관', '창문'] as const).filter((n) => !(n in known));

  const base = {
    effectiveDefenseCm: null as number | null,
    weakestPoint: null as '현관' | '창문' | null,
    inflowCm: null as number | null,
    needBarrierCm: null as number | null,
    unknownOpenings: unknownOpenings as string[],
  };

  const names = Object.keys(known);
  if (names.length === 0) {
    return { ...base, status: '확인필요',
      reason: '현관 턱과 창문 위치를 모두 확인하지 못했습니다.' };
  }

  const weakest = names.reduce((a, b) => (known[a] <= known[b] ? a : b)) as '현관' | '창문';
  const effective = known[weakest];
  base.effectiveDefenseCm = effective;
  base.weakestPoint = weakest;

  if (floodDepthCm === null || floodDepthCm === undefined) {
    return { ...base, status: '확인필요',
      reason: '해당 주소의 예상침수심 정보를 조회하지 못했습니다.' };
  }

  /* 아는 개구부만으로 이미 유입이 확정되면 모르는 쪽과 무관하게 결론이 같다. */
  if (floodDepthCm > effective) {
    let reason = `예상침수심 ${floodDepthCm}cm 가 ${weakest} 방어높이 ${effective}cm 를 초과합니다.`;
    if (unknownOpenings.length) reason += ` (${unknownOpenings[0]} 상태는 확인하지 못했습니다.)`;
    return { ...base, status: '유입가능', reason,
      inflowCm: round1(floodDepthCm - effective),
      // 행안부 고시 제23조: 예상 침수 높이 이상의 여유고 확보
      needBarrierCm: round1(floodDepthCm) };
  }

  /* 아는 개구부는 방어되지만, 모르는 개구부가 최약점일 수 있다.
     "안전하다" 는 전부 알아야 말할 수 있으므로 여기서 방어가능을 선언하지 않는다. */
  if (unknownOpenings.length) {
    const u = unknownOpenings[0];
    return { ...base, status: '확인필요',
      reason: `${weakest} 방어높이 ${effective}cm 는 예상침수심 ${floodDepthCm}cm 이상이지만, `
        + `${u} 상태를 확인하지 못해 방어 가능 여부를 결론지을 수 없습니다.` };
  }

  return { ...base, status: '방어가능',
    reason: `${weakest} 방어높이 ${effective}cm 가 예상침수심 ${floodDepthCm}cm 이상입니다.`,
    inflowCm: 0 };
}

// ─────────────────────────────────────────────────────────────
// 경로 B — 내부 역류
//   역류 발생 확률은 하수관망 해석의 영역이므로 예측하지 않는다.
//   '막을 장치가 있는가' 와 '이미 전조가 나타나는가' 만 판정한다.
// ─────────────────────────────────────────────────────────────
function diagnoseBackflow(
  s: Record<string, string | null>,
  buildYear: number | null,
): BackflowResult {
  const symptoms: string[] = [];

  if (s.rainy_symptom === '있음') {
    symptoms.push('비가 올 때만 배수가 지연됩니다. 하수관 수위 상승 신호입니다.');
  }
  if (s.gurgling === '있음') {
    symptoms.push('배수 시 이상음이 발생합니다. 배관 내 압력 이상입니다.');
  }
  if (buildYear !== null && buildYear !== undefined && buildYear < 1995) {
    symptoms.push('1995년 이전 건축물로 배관 노후가 예상됩니다.');
  }

  const signals = [...symptoms];
  if (s.backflow_valve === '없음') {
    signals.push('역류방지밸브가 설치되어 있지 않습니다.');
  }

  // 이미 경험했다면 징후가 아니라 사실이므로 상태를 확정한다.
  const experienced = s.floor_backup === '있음';
  if (experienced) {
    signals.unshift('바닥 배수구에서 물이 올라온 경험이 있습니다.');
  }

  const core = ['backflow_valve', 'rainy_symptom', 'gurgling', 'floor_backup'];
  const unknownItems = core.filter((k) => isUnknown(s[k]));

  let status: BackflowStatus;
  if (experienced) status = '매우미흡';
  else if (symptoms.length >= 2) status = '매우미흡';
  else if (symptoms.length >= 1) status = '미흡';
  else if (unknownItems.length === core.length) status = '확인필요';
  else status = '양호';

  return { status, signals, signalCount: signals.length, experienced, unknownItems };
}

// ─────────────────────────────────────────────────────────────
// 가중 요인 — 점수화하지 않고 경고로만 표기
// ─────────────────────────────────────────────────────────────
function collectWarnings(s: Record<string, string | null>): string[] {
  const w: string[] = [];
  if (s.window_base === '땅보다낮음') {
    w.push('창문 하단이 지면보다 낮아 직접 유입 위험이 있습니다.');
  }
  if (s.canopy === '없음') {
    w.push('현관 위 차양이 없어 빗물이 출입구로 직접 떨어집니다.');
  }
  if (s.road_slope === '내리막') {
    w.push('골목이 집 방향으로 기울어 주변 빗물이 모입니다.');
  }
  if (s.drain_status === '막힘의심') {
    w.push('빗물받이 막힘이 의심됩니다. 구청 신고를 권장합니다.');
  }
  if (s.drain_status === '없음') {
    w.push('주변에 빗물받이가 확인되지 않습니다.');
  }
  if (s.stair_count === '3-4' || s.stair_count === '5이상') {
    const d = STAIR_DEPTH_CM[s.stair_count as string];
    w.push(`실내 바닥이 지면보다 약 ${d}cm 낮아 유입 시 배수가 어렵습니다.`);
  }
  return w;
}

// ─────────────────────────────────────────────────────────────
// 조치 안내
//   안양시 지원 현황 (2026년 9월 담당부서 확인 기준)
//     지원   : 창문 차수막, 배수 펌프
//     미지원 : 현관 물막이판, 역류방지밸브
// ─────────────────────────────────────────────────────────────
function buildActions(
  surface: SurfaceResult,
  backflow: BackflowResult,
  s: Record<string, string | null>,
): ActionItem[] {
  const actions: ActionItem[] = [];

  if (surface.status === '유입가능' && surface.needBarrierCm !== null) {
    const need = surface.needBarrierCm;
    if (surface.weakestPoint === '창문' && s.window_barrier === '미설치') {
      actions.push({
        item: '창문 차수막 설치',
        detail: `최소 ${need}cm 이상 높이로 설치가 필요합니다.`,
        support: '안양시 지원 대상입니다. 동주민센터에 문의하세요.',
      });
    }
    if (s.water_panel === '미설치') {
      actions.push({
        item: '현관 물막이판 설치',
        detail: `최소 ${need}cm 이상 높이로 설치가 필요합니다.`,
        support: '안양시는 현재 지원하지 않습니다. 자비 설치 또는 임대인 협의가 필요합니다.',
      });
    }
  }

  if ((backflow.status === '미흡' || backflow.status === '매우미흡')
      && s.backflow_valve === '없음') {
    actions.push({
      item: '역류방지밸브 설치',
      detail: '물막이판으로는 역류를 막을 수 없습니다. 별도 설치가 필요합니다.',
      support: '안양시는 현재 지원하지 않습니다. 인근 지자체는 지원하는 사례가 있습니다.',
    });
  }

  if (s.drain_status === '막힘의심') {
    actions.push({
      item: '빗물받이 준설 신고',
      detail: '낙엽·토사로 막힌 빗물받이는 설계 배수 용량을 쓰지 못합니다.',
      support: '안양시 또는 동주민센터에 신고할 수 있습니다.',
    });
  }

  return actions;
}

/** 강우 시 행동요령 — 진단 결과와 무관하게 동일하게 제공한다. */
export const RAIN_GUIDE: string[] = [
  '지하 계단에 물이 조금이라도 흘러 들어오면 그때가 대피 시점입니다.',
  '계단 물높이가 종아리(약 40cm)에 닿기 전에 나오십시오.',
  '짐 정리나 물 퍼내기를 시도하지 마십시오.',
  '대피 시 슬리퍼 대신 운동화를 신으십시오.',
  '문 밖 수심이 무릎 이상이면 혼자 열지 말고 여러 명이 함께 미십시오.',
];

// ─────────────────────────────────────────────────────────────
// 공개 함수
// ─────────────────────────────────────────────────────────────
export function diagnose(
  slots: Partial<Slots>,
  floodDepthCm: number | null = null,
  buildYear: number | null = null,
): DiagnoseResult {
  const errors = validateSlots(slots);
  if (errors.length > 0) {
    throw new Error('슬롯 값 오류: ' + errors.join('; '));
  }

  const norm: Record<string, string | null> = {};
  for (const sid of SLOT_IDS) {
    const v = slots[sid] as string | undefined;
    norm[sid] = isUnknown(v) ? null : (v as string);
  }

  const surface = diagnoseSurface(norm, floodDepthCm);
  const backflow = diagnoseBackflow(norm, buildYear);
  const warnings = collectWarnings(norm);
  const actions = buildActions(surface, backflow, norm);

  const unknownCount = SLOT_IDS.filter((sid) => norm[sid] === null).length;

  return {
    floodDepthCm,
    surface,
    backflow,
    warnings,
    actions,
    rainGuide: RAIN_GUIDE,
    quality: {
      unknownCount,
      totalSlots: SLOT_IDS.length,
      unknownRate: Math.round((unknownCount / SLOT_IDS.length) * 1000) / 1000,
      reliable: unknownCount <= 3,
    },
  };
}

export default diagnose;
