/**
 * 잠길까 — LLM 슬롯 추출 프롬프트 및 스키마
 *
 * 이 파일은 프론트엔드와 Cloud Functions 양쪽에서 import 하는 공용 계약이다.
 * 외부 의존성이 없으므로 어디서든 불러 쓸 수 있다.
 *
 *   프론트  : SLOT_SPEC 으로 질문 순서·선택지 버튼을 렌더링
 *   Functions: buildSystemPrompt / EXTRACTION_SCHEMA 로 OpenAI 호출
 *
 * 핵심 원칙
 *  1. LLM 은 값 추출만 한다. 위험 판정은 src/utils/diagnose.ts 가 전담.
 *  2. 확신이 없으면 반드시 'unknown'. 추측 금지.
 *  3. 허용 Enum 밖의 값은 파싱 단계에서 'unknown' 으로 강제 치환.
 *  4. 슬롯 ID 와 Enum 은 src/utils/diagnose.ts 의 ALLOWED 와 반드시 일치.
 *
 * 항목 선정 근거
 *  서울 강동구 「반지하주택 전수조사 시행계획(2023)」의 조사 항목
 *  (경사도, 배수로 유무, 계단, 세대출입문, 창문 등 침수위험요소)과
 *  행정안전부 「지하공간 침수 방지를 위한 수방기준」을 대조해 구성하였다.
 *
 * 작성: 차동현
 */

// ─────────────────────────────────────────────────────────────
// 슬롯 명세 — 챗봇 12문항의 단일 진실 공급원(Single Source of Truth)
// ─────────────────────────────────────────────────────────────
export interface SlotOption {
  /** 버튼에 표시할 문구 */
  label: string;
  /** 저장될 Enum 값 */
  value: string;
}

export interface SlotSpec {
  /** 0부터 시작하는 문진 순서 */
  step: number;
  /** DB 컬럼명과 동일 */
  id: string;
  /** 챗봇이 던지는 질문 */
  question: string;
  /** 질문 아래 작게 표시할 보충 설명. 없으면 생략 */
  hint?: string;
  /** LLM 실패 또는 unknown 반환 시 노출할 큰 글씨 버튼 */
  options: SlotOption[];
  /** 허용 Enum. 반드시 diagnose.ts 의 ALLOWED 와 일치 */
  enumValues: string[];
  /** 사용자가 모른다고 할 때 사진 업로드를 제안할지 여부 */
  photoAssist: boolean;
  /** 판정에서의 역할. 사업계획서 서술 및 디버깅용 */
  role: 'surface' | 'backflow' | 'warning';
}

const UNKNOWN = 'unknown';
const UNKNOWN_OPTION: SlotOption = { label: '잘 모르겠어요', value: UNKNOWN };

export const SLOT_SPEC: SlotSpec[] = [
  {
    step: 0,
    id: 'entrance_sill',
    question: '현관문 앞에 턱이 있나요? 있다면 신용카드를 몇 장 쌓은 높이인가요?',
    hint: '턱은 문 아래쪽에서 물을 막아주는 낮은 단차입니다. 신용카드 긴 쪽 길이는 약 8.5cm이니, 카드를 세로로 세워 몇 개나 되는지 보시면 됩니다.',
    options: [
      { label: '턱이 없어요', value: '없음' },
      { label: '카드 1개 정도예요', value: '카드1개' },
      { label: '카드 2개 정도예요', value: '카드2개' },
      { label: '카드 3개 이상이에요', value: '카드3개이상' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['없음', '카드1개', '카드2개', '카드3개이상', UNKNOWN],
    photoAssist: true,
    role: 'surface',
  },
  {
    step: 1,
    id: 'stair_count',
    question: '현관까지 내려가는 계단이 몇 칸인가요?',
    hint: '계단 한 칸은 보통 15~18cm입니다. 칸수가 많을수록 집이 길보다 깊이 있습니다.',
    options: [
      { label: '없어요 (평지)', value: '0' },
      { label: '1~2칸', value: '1-2' },
      { label: '3~4칸', value: '3-4' },
      { label: '5칸 이상', value: '5이상' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['0', '1-2', '3-4', '5이상', UNKNOWN],
    photoAssist: false,
    role: 'warning',
  },
  {
    step: 2,
    id: 'water_panel',
    question: '현관에 물막이판이 설치되어 있나요?',
    hint: '물막이판은 비 올 때 문 앞에 세우는 금속이나 플라스틱 판입니다.',
    options: [
      { label: '설치되어 있어요', value: '설치' },
      { label: '없어요', value: '미설치' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['설치', '미설치', UNKNOWN],
    photoAssist: true,
    role: 'surface',
  },
  {
    step: 3,
    id: 'window_base',
    question: '방 창문의 아래쪽이 바깥 땅바닥과 비교해서 어떤가요? 땅보다 높다면 신용카드 몇 장 높이인가요?',
    hint: '창문이 땅에 파묻힌 형태라면 물이 가장 먼저 들어오는 곳이 됩니다. 신용카드 긴 쪽 길이는 약 8.5cm입니다.',
    options: [
      { label: '땅보다 낮아요 (창이 땅에 묻혀 있어요)', value: '땅보다낮음' },
      { label: '땅과 거의 같아요', value: '비슷' },
      { label: '카드 1개 정도 높아요', value: '카드1개' },
      { label: '카드 2개 정도 높아요', value: '카드2개' },
      { label: '카드 3개 이상 높아요', value: '카드3개이상' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['땅보다낮음', '비슷', '카드1개', '카드2개', '카드3개이상', UNKNOWN],
    photoAssist: true,
    role: 'surface',
  },
  {
    step: 4,
    id: 'window_barrier',
    question: '창문에 차수막이 설치되어 있나요?',
    hint: '창문 차수막은 창 아래를 막아 물이 들어오지 못하게 하는 판입니다. 안양시 지원 품목입니다.',
    options: [
      { label: '설치되어 있어요', value: '설치' },
      { label: '없어요', value: '미설치' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['설치', '미설치', UNKNOWN],
    photoAssist: true,
    role: 'surface',
  },
  {
    step: 5,
    id: 'backflow_valve',
    question: '집 안 배수구에 역류방지밸브가 설치되어 있나요?',
    hint: '하수구 뚜껑을 열었을 때 물이 거꾸로 올라오지 못하게 막는 장치입니다. 역지변이라고도 합니다.',
    options: [
      { label: '있어요', value: '있음' },
      { label: '없어요', value: '없음' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['있음', '없음', UNKNOWN],
    photoAssist: true,
    role: 'backflow',
  },
  {
    step: 6,
    id: 'rainy_symptom',
    question: '비가 많이 오는 날에 화장실 물이 잘 안 내려가거나 하수구 냄새가 올라온 적이 있나요?',
    hint: '평소에는 괜찮은데 비 올 때만 그렇다면 하수관 수위가 올라오고 있다는 신호입니다.',
    options: [
      { label: '그런 적 있어요', value: '있음' },
      { label: '없어요', value: '없음' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['있음', '없음', UNKNOWN],
    photoAssist: false,
    role: 'backflow',
  },
  {
    step: 7,
    id: 'gurgling',
    question: '변기 물을 내릴 때 다른 배수구에서 꿀럭거리는 소리가 나나요?',
    hint: '배관 안의 압력이 정상이 아닐 때 나는 소리입니다.',
    options: [
      { label: '소리가 나요', value: '있음' },
      { label: '안 나요', value: '없음' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['있음', '없음', UNKNOWN],
    photoAssist: false,
    role: 'backflow',
  },
  {
    step: 8,
    id: 'floor_backup',
    question: '바닥 배수구에서 물이 올라온 적이 있나요?',
    hint: '조금이라도 올라온 경험이 있다면 이미 역류가 시작된 것입니다.',
    options: [
      { label: '올라온 적 있어요', value: '있음' },
      { label: '없어요', value: '없음' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['있음', '없음', UNKNOWN],
    photoAssist: false,
    role: 'backflow',
  },
  {
    step: 9,
    id: 'road_slope',
    question: '집 앞 골목이 큰길과 비교해서 어떤가요?',
    hint: '골목이 집 쪽으로 기울어 있으면 주변 빗물이 모여듭니다.',
    options: [
      { label: '집 쪽으로 내려가요', value: '내리막' },
      { label: '평평해요', value: '평지' },
      { label: '집 쪽이 더 높아요', value: '오르막' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['내리막', '평지', '오르막', UNKNOWN],
    photoAssist: true,
    role: 'warning',
  },
  {
    step: 10,
    id: 'drain_status',
    question: '집 근처에 빗물받이가 있나요? 있다면 낙엽 같은 것으로 막혀 있진 않나요?',
    hint: '빗물받이는 도로 가장자리에 있는 사각형 배수구입니다.',
    options: [
      { label: '있고 깨끗해요', value: '양호' },
      { label: '있는데 막힌 것 같아요', value: '막힘의심' },
      { label: '근처에 없어요', value: '없음' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['양호', '막힘의심', '없음', UNKNOWN],
    photoAssist: true,
    role: 'warning',
  },
  {
    step: 11,
    id: 'canopy',
    question: '현관 위에 지붕이나 차양이 있나요?',
    hint: '차양이 없으면 빗물이 현관으로 바로 떨어집니다.',
    options: [
      { label: '있어요', value: '있음' },
      { label: '없어요', value: '없음' },
      UNKNOWN_OPTION,
    ],
    enumValues: ['있음', '없음', UNKNOWN],
    photoAssist: true,
    role: 'warning',
  },
];

export const TOTAL_STEPS = SLOT_SPEC.length; // 12

/** step 번호로 슬롯 명세를 가져온다. 범위를 벗어나면 null. */
export function getSlotByStep(step: number): SlotSpec | null {
  return SLOT_SPEC[step] ?? null;
}

/** 슬롯 id 로 명세를 가져온다. */
export function getSlotById(id: string): SlotSpec | null {
  return SLOT_SPEC.find((s) => s.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────
// 시스템 프롬프트
// ─────────────────────────────────────────────────────────────
export function buildSystemPrompt(slot: SlotSpec): string {
  const allowed = slot.enumValues.map((v) => `"${v}"`).join(', ');

  return `당신은 반지하 침수 대비 진단 서비스의 대화 도우미입니다.
사용자의 답변에서 아래 항목의 값 하나를 골라내는 일만 합니다.

[현재 질문]
${slot.question}

[고를 수 있는 값]
${allowed}

[반드시 지킬 규칙]
1. 위 목록에 있는 값 중 하나만 고릅니다. 새로운 값을 만들지 않습니다.
2. 조금이라도 확신이 서지 않으면 반드시 "${UNKNOWN}"을 고릅니다. 절대 추측하지 않습니다.
3. 위험도를 판정하지 않습니다. 점수나 등급을 말하지 않습니다. 값 추출만 합니다.
4. 사용자가 질문을 하면 intent를 "question"으로 하고 value는 null로 둡니다.
5. 답변이 현재 질문과 무관하면 intent를 "unclear"로 하고 value는 null로 둡니다.
6. reply는 한두 문장으로 짧게 씁니다. 불안을 조성하는 표현을 쓰지 않습니다.
7. 사용자가 고령일 수 있으므로 쉬운 말로 대답합니다.

[판독 기준]
- 신용카드를 세로로 세운 길이는 약 8.5cm입니다.
- 계단 한 칸은 보통 15~18cm입니다.
- "조금", "약간", "그런 것 같다" 처럼 모호한 표현만 있고 방향이 분명하지 않으면 "${UNKNOWN}"입니다.
- "잘 모르겠다", "확인 못 했다", "안 보인다"는 모두 "${UNKNOWN}"입니다.

[intent 판별]
- answer   : 질문에 대한 답을 했다
- question : 사용자가 되물었다 (예: "물막이판이 뭐예요?")
- unclear  : 답인지 아닌지 알 수 없거나 주제와 무관하다

JSON 형식으로만 응답합니다.`;
}

/** 사용자가 되물었을 때 설명해 주는 모드의 시스템 프롬프트 */
export function buildAnswerPrompt(slot: SlotSpec): string {
  return `당신은 반지하 침수 대비 진단 서비스의 대화 도우미입니다.
사용자가 용어나 절차에 대해 질문했습니다. 두세 문장으로 쉽게 설명해 주세요.

[현재 진행 중인 질문]
${slot.question}
${slot.hint ? `[참고] ${slot.hint}` : ''}

[규칙]
1. 설명은 두세 문장을 넘기지 않습니다.
2. 설명이 끝나면 현재 질문을 다시 한 번 자연스럽게 안내합니다.
3. 위험도를 판정하거나 점수를 말하지 않습니다.
4. 확실하지 않은 정보는 말하지 않습니다.
5. 고령자도 이해할 수 있는 쉬운 말을 씁니다.`;
}

// ─────────────────────────────────────────────────────────────
// OpenAI Structured Output 스키마
//   response_format: { type: 'json_schema', json_schema: EXTRACTION_SCHEMA }
// ─────────────────────────────────────────────────────────────
export function buildExtractionSchema(slot: SlotSpec) {
  return {
    name: 'slot_extraction',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['answer', 'question', 'unclear'],
          description: '사용자 발화의 의도',
        },
        value: {
          type: ['string', 'null'],
          enum: [...slot.enumValues, null],
          description: `추출된 값. intent가 answer가 아니면 null`,
        },
        confidence: {
          type: 'string',
          enum: ['high', 'low'],
          description: '추출 확신도. low면 선택지 버튼을 노출한다',
        },
        reply: {
          type: 'string',
          description: '사용자에게 보여줄 한두 문장의 응답',
        },
      },
      required: ['intent', 'value', 'confidence', 'reply'],
      additionalProperties: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 응답 파싱 및 검증
// ─────────────────────────────────────────────────────────────
export type Intent = 'answer' | 'question' | 'unclear';

export interface ExtractionResult {
  intent: Intent;
  /** 확정된 슬롯 값. 확정 못 하면 null */
  value: string | null;
  confidence: 'high' | 'low';
  reply: string;
  /** true 면 프론트에서 선택지 버튼을 노출한다 */
  needsFallback: boolean;
}

const DEFAULT_REPLY = '알겠습니다. 아래에서 골라 주세요.';

/**
 * LLM 원본 응답을 안전하게 파싱한다.
 * 어떤 입력이 와도 예외를 던지지 않고 항상 유효한 결과를 반환한다.
 * 파싱 실패, Enum 위반, 빈 응답은 모두 폴백으로 처리한다.
 */
export function parseExtraction(raw: unknown, slot: SlotSpec): ExtractionResult {
  const fallback = (reply = DEFAULT_REPLY): ExtractionResult => ({
    intent: 'unclear',
    value: null,
    confidence: 'low',
    reply,
    needsFallback: true,
  });

  let obj: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return fallback();
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  } else {
    return fallback();
  }

  const intent = obj.intent;
  if (intent !== 'answer' && intent !== 'question' && intent !== 'unclear') {
    return fallback();
  }

  const reply = typeof obj.reply === 'string' && obj.reply.trim()
    ? obj.reply.trim()
    : DEFAULT_REPLY;

  // 되물음이면 값을 확정하지 않고 대화를 이어간다. 버튼은 띄우지 않는다.
  if (intent === 'question') {
    return { intent, value: null, confidence: 'low', reply, needsFallback: false };
  }

  if (intent === 'unclear') {
    return { intent, value: null, confidence: 'low', reply, needsFallback: true };
  }

  // intent === 'answer'
  const v = obj.value;
  if (typeof v !== 'string' || !slot.enumValues.includes(v)) {
    // 허용 Enum 밖의 값은 신뢰하지 않는다
    return fallback();
  }

  const confidence = obj.confidence === 'high' ? 'high' : 'low';

  // unknown 이거나 확신이 낮으면 버튼을 띄워 사용자가 직접 고르게 한다
  const needsFallback = v === UNKNOWN || confidence === 'low';

  return { intent, value: v, confidence, reply, needsFallback };
}

/** 타임아웃·네트워크 오류 등 호출 자체가 실패했을 때 사용한다. */
export function extractionFailure(): ExtractionResult {
  return {
    intent: 'unclear',
    value: null,
    confidence: 'low',
    reply: '답변을 이해하지 못했어요. 아래에서 골라 주세요.',
    needsFallback: true,
  };
}

// ─────────────────────────────────────────────────────────────
// OpenAI 호출 파라미터 권장값
// ─────────────────────────────────────────────────────────────
export const LLM_CONFIG = {
  /** 값 추출에 창의성은 불필요하다. 낮출수록 결과가 일관된다. */
  temperature: 0,
  /** 추출 응답은 짧다. 비용과 지연을 함께 줄인다. */
  max_tokens: 300,
  /** 이 시간을 넘으면 폴백 버튼으로 전환한다. */
  timeoutMs: 8000,
} as const;

export { UNKNOWN };
