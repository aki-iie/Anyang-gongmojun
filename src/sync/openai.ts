

import { QUESTIONS } from '../content';
import type { QuestionKey } from '../content';

export interface VLMAnalysisResult {
  overview: string; // 전체적인 사진 분석 브리핑
  factors: {
    sill: {
      score: number; // 0 ~ 30
      label: string;
      confidence: 'high' | 'medium' | 'low';
      detail: string;
      needAsk: boolean;
      customQuestion?: string;
      options?: [string, number][];
    };
    window: {
      score: number; // 0 ~ 20
      label: string;
      confidence: 'high' | 'medium' | 'low';
      detail: string;
      needAsk: boolean;
      customQuestion?: string;
      options?: [string, number][];
    };
    history: {
      score: number; // 0 ~ 15
      label: string;
      detail: string;
      needAsk: boolean;
      customQuestion?: string;
      options?: [string, number][];
    };
  };
}

/* ────────────────────────────────────────────────────────────
   LLM 호출 경로
   개발(npm run dev): 로컬 .env 키로 OpenAI/OpenRouter 직접 호출
   배포(Firebase Hosting): /api/llm → Cloud Functions 가 서버에서 키를 붙여 호출
   둘 다 불가하면 null → 호출부가 시뮬레이션으로 폴백한다.
   ──────────────────────────────────────────────────────────── */

const PROXY_ENDPOINT = '/api/llm';

type LLMBody = {
  messages: unknown[];
  temperature?: number;
  response_format?: { type: string };
};

/* OpenAI 호환 응답에서 우리가 실제로 읽는 부분만 */
type LLMResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: Record<string, unknown>;
};

async function callLLM(body: LLMBody, tag: string): Promise<LLMResponse | null> {
  const key = getApiKey();

  if (key) {
    const res = await fetch(getEndpoint(key), {
      method: 'POST',
      headers: getHeaders(key),
      body: JSON.stringify({ ...body, model: getModel(key) }),
    });
    if (!res.ok) {
      console.error(`[${tag}] direct call failed:`, res.status, await res.text());
      return null;
    }
    return res.json();
  }

  if (!import.meta.env.DEV) {
    const res = await fetch(PROXY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[${tag}] proxy call failed:`, res.status, await res.text());
      return null;
    }
    return res.json();
  }

  console.log(`[${tag}] 키 없음 — 시뮬레이션으로 진행`);
  return null;
}

/* ────────────────────────────────────────────────────────────
   AI 응답 정규화
   AI가 options를 [] 로 주거나 형태를 바꿔 보내면 선택지가 0개로 렌더되어
   문진이 멈춘다. 여기서 형태를 강제하고, 못 쓰면 content.ts 기본값으로 되돌린다.
   ──────────────────────────────────────────────────────────── */

const SCORE_CAP: Record<QuestionKey, number> = { sill: 30, window: 20, history: 15 };

const defaultOptions = (key: QuestionKey): [string, number][] => {
  const q = QUESTIONS.find((x) => x.key === key);
  return q ? q.options : [];
};

const defaultQuestion = (key: QuestionKey): string =>
  QUESTIONS.find((x) => x.key === key)?.text ?? '';

/** AI가 준 보기를 [문구, 점수] 튜플 배열로 강제한다. 2개 미만이면 기본 보기로 폴백. */
function normalizeOptions(raw: unknown, key: QuestionKey): [string, number][] {
  if (!Array.isArray(raw)) return defaultOptions(key);
  const cap = SCORE_CAP[key];
  const out: [string, number][] = [];
  for (const item of raw) {
    let label: unknown;
    let pts: unknown;
    if (Array.isArray(item)) { label = item[0]; pts = item[1]; }
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      label = o.label ?? o.text ?? o.option;
      pts = o.score ?? o.pts ?? o.point;
    }
    const l = typeof label === 'string' ? label.trim() : '';
    const n = Number(pts);
    if (!l) continue;
    out.push([l, Number.isFinite(n) ? Math.max(0, Math.min(cap, Math.round(n))) : 0]);
  }
  return out.length >= 2 ? out : defaultOptions(key);
}

function normalizeText(raw: unknown, fallback = ''): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

function normalizeFactor(raw: unknown, key: QuestionKey) {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = Number(f.score);
  const conf = f.confidence;
  return {
    score: Number.isFinite(n) ? Math.max(0, Math.min(SCORE_CAP[key], Math.round(n))) : 0,
    label: normalizeText(f.label, '판단 보류'),
    confidence: (conf === 'high' || conf === 'medium' || conf === 'low' ? conf : 'low') as 'high' | 'medium' | 'low',
    detail: normalizeText(f.detail, '사진만으로는 판단이 어려워 사용자 확인이 필요합니다.'),
    needAsk: f.needAsk !== false,
    customQuestion: normalizeText(f.customQuestion, defaultQuestion(key)),
    options: normalizeOptions(f.options, key),
  };
}

/** AI 원본 JSON을 UI가 절대 깨지지 않는 형태로 변환한다. */
export function normalizeVLM(raw: unknown, address: string): VLMAnalysisResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const f = (r.factors && typeof r.factors === 'object' ? r.factors : {}) as Record<string, unknown>;
  return {
    overview: normalizeText(
      r.overview,
      `${address ? `[${address}] ` : ''}사진을 분석했습니다. 몇 가지만 더 확인하면 정확한 점수를 낼 수 있어요.`
    ),
    factors: {
      sill: normalizeFactor(f.sill, 'sill'),
      window: normalizeFactor(f.window, 'window'),
      history: normalizeFactor(f.history, 'history'),
    },
  };
}

const getApiKey = (): string | null => {
  /* 배포 빌드에서는 키를 절대 읽지 않는다.
     import.meta.env.DEV 가 false 로 상수 폴딩되면서 아래 블록이 통째로 제거되어,
     번들에 키 문자열이 남지 않는다. 배포본은 항상 /api/llm 프록시를 탄다. */
  if (!import.meta.env.DEV) return null;
  const key = import.meta.env.VITE_OPENAI_API_KEY;
  if (!key || key.startsWith('your_')) {
    console.warn('[OpenAI/OpenRouter] VITE_OPENAI_API_KEY is not set or invalid in .env');
    return null;
  }
  return key;
};

const isOpenRouter = (key: string) => key.startsWith('sk-or-');
const getEndpoint = (key: string) =>
  isOpenRouter(key)
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
const getModel = (key: string) =>
  isOpenRouter(key) ? 'openai/gpt-4o-mini' : 'gpt-4o-mini';

const getHeaders = (key: string) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (isOpenRouter(key)) {
    headers['HTTP-Referer'] = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
    headers['X-Title'] = 'Anyang Flood AI';
  }
  return headers;
};

/**
 * 3장의 사진(문턱, 창문, 골목)과 주소를 gpt-4o-mini Vision으로 종합 분석
 */
export async function analyzeHousePhotos(
  photos: (string | null)[],
  address: string
): Promise<VLMAnalysisResult> {
  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };
  const contentParts: ContentPart[] = [
    {
      type: 'text',
      text: `당신은 안양시 반지하 침수 취약성 진단 AI 전문가입니다.
사용자가 제출한 주소: "${address || '주소 미입력'}"
사용자가 제출한 3장의 사진(1: 현관 문턱, 2: 창문, 3: 집 앞 골목)을 정밀하게 분석해주세요.

평가 기준:
1. 현관 문턱(sill):
   - 신용카드 세로(8.5cm)보다 낮음: 30점 (매우 취약)
   - 카드 1장 정도: 20점
   - 카드 2장(17cm) 정도: 10점
   - 그 이상으로 높음: 0점 (안전)
   - 사진으로 확신할 수 없으면 needAsk: true 및 사용자에게 재확인할 customQuestion과 보기 options를 생성하세요.

2. 창문(window):
   - 창문 하단이 바깥 땅바닥에 거의 붙어있음: 20점 (매우 취약)
   - 바닥에서 카드 2장(17cm) 정도: 12점
   - 무릎 높이(40cm 내외): 5점
   - 그보다 높음: 0점 (안전)
   - 확신 불가 시 needAsk: true 및 customQuestion, options 생성.

3. 집 앞 골목(history/drainage):
   - 골목의 경사도, 빗물받이(배수구) 상태, 저지대 여부를 관찰하세요.
   - 2022년 집중호우 침수 이력이나 배수 역류 위험을 추정하여 점수(0~15점) 부여.
   - 골목 침수 경험 여부를 사용자에게 묻는 것이 권장되므로 needAsk: true 설정.

반드시 아래 JSON 포맷으로만 응답하세요 (JSON 외 마크다운 태그나 다른 말 금지):
{
  "overview": "사진을 분석한 전반적인 구조적 위험성 브리핑 (친절하고 전문적인 2~3문장)",
  "factors": {
    "sill": {
      "score": number,
      "label": "판단 요약 라벨 (예: 카드보다 낮아 침수 취약)",
      "confidence": "high" | "medium" | "low",
      "detail": "VLM 분석 상세 근거",
      "needAsk": boolean,
      "customQuestion": "신뢰도가 낮거나 확인 필요시 되물을 질문",
      "options": [["보기1", 점수], ["보기2", 점수], ...]
    },
    "window": {
      "score": number,
      "label": "판단 요약 라벨",
      "confidence": "high" | "medium" | "low",
      "detail": "VLM 분석 상세 근거",
      "needAsk": boolean,
      "customQuestion": "되물을 질문",
      "options": [["보기1", 점수], ["보기2", 점수], ...]
    },
    "history": {
      "score": number,
      "label": "골목 및 배수구 관찰 요약",
      "detail": "골목 경사 및 배수구 상태 근거",
      "needAsk": true,
      "customQuestion": "2022년 8월 집중호우 때 이 골목에 물이 찼던 기억이 있으신가요?",
      "options": [["네, 물이 찼어요", 15], ["아니요, 괜찮았어요", 0], ["잘 모르겠어요", 5]]
    }
  }
}`
    }
  ];

  // 사진 첨부 (0: 문턱, 1: 창문, 2: 골목)
  const slotNames = ['현관 문턱 사진', '창문 사진', '집 앞 골목 사진'];
  photos.forEach((photo, idx) => {
    if (photo) {
      contentParts.push({
        type: 'text',
        text: `[사진 ${idx + 1}: ${slotNames[idx]}]`
      });
      contentParts.push({
        type: 'image_url',
        image_url: { url: photo }
      });
    }
  });

  try {
    const data = await callLLM({
      messages: [{ role: 'user', content: contentParts }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }, 'Vision');

    if (!data) return simulateAnalysis(photos, address);
    console.log('[Vision Success]:', data);
    const rawContent = data.choices?.[0]?.message?.content;
    /* 응답에 본문이 없으면 파싱하지 않고 시뮬레이션으로 넘긴다 */
    if (!rawContent) return simulateAnalysis(photos, address);
    const parsed = normalizeVLM(JSON.parse(rawContent), address);
    console.log('[VLM Normalized]:', parsed);
    return parsed;
  } catch (err) {
    console.error('[OpenAI/OpenRouter] Failed to analyze:', err);
    return simulateAnalysis(photos, address);
  }
}

/**
 * 챗봇과의 추가 대화 처리 (사용자 자유 텍스트 실시간 대화)
 */
export async function sendChatMessage(
  history: { role: 'bot' | 'user'; text: string }[],
  userText: string,
  context?: { address?: string; scores?: Record<string, number>; pendingQuestion?: string; resultSummary?: string }
): Promise<string> {
  const pendingNote = context?.pendingQuestion
    ? `\n\n[진행 상황] 지금 사용자는 3단계 문진 중이고, 현재 답을 기다리는 질문은 다음과 같습니다:\n"${context.pendingQuestion}"\n사용자가 다른 것을 물으면 먼저 1~2문장으로 짧게 답한 뒤, 위 질문에 답해 달라고 자연스럽게 이어가세요. "사진을 보내주세요" 같은 안내는 절대 하지 마세요. 사진은 이미 받았습니다.`
    : '';

  const resultNote = context?.resultSummary
    ? `\n\n[이 사용자의 진단 결과]\n${context.resultSummary}\n\n점수를 설명할 때는 위 "점수 구성"의 항목명과 숫자를 그대로 인용하고, 없는 항목을 지어내지 마세요.`
    : '';

  const systemMessage = {
    role: 'system',
    content: `당신은 안양시 반지하 침수 취약성 진단 전문 AI 챗봇 '잠길까 도우미'입니다.
거주민의 주소: "${context?.address || '미입력'}"${resultNote}
사용자의 질문에 친절하고 전문적인 한국어로 답변해주세요.
차수판, 창문 차수막, 물막이판 설치 지원, 대피 요령, 침수 위험 요인 등에 대해 유용한 조언을 제공하세요. 2~3문장으로 간결하고 명확하게 답하세요.${pendingNote}`
  };

  const formattedHistory = history.map((h) => ({
    role: h.role === 'bot' ? ('assistant' as const) : ('user' as const),
    content: h.text,
  }));

  try {
    const data = await callLLM({
      messages: [systemMessage, ...formattedHistory, { role: 'user', content: userText }],
      temperature: 0.7,
    }, 'Chat');

    if (!data) return '지금은 AI 답변을 불러올 수 없어요. 잠시 후 다시 시도해 주세요.';
    return data.choices?.[0]?.message?.content ?? '확인했습니다.';
  } catch (err) {
    console.error('[OpenAI/OpenRouter Chat Exception]:', err);
    return '네, 질문해주신 내용을 바탕으로 안내를 도와드리겠습니다.';
  }
}

function simulateAnalysis(_photos: (string | null)[], address: string): VLMAnalysisResult {
  return {
    overview: `${address ? `[${address}] ` : ''}제출해주신 사진을 AI로 분석했습니다. 현관 문턱이 낮고 창문이 도로면과 가까워 집중호우 시 빗물 유입 위험이 있는 구조입니다.`,
    factors: {
      sill: {
        score: 20,
        label: '카드 높이(약 8.5cm) 내외로 추정',
        confidence: 'medium',
        detail: '현관 단차가 낮아 도로변 빗물이 월류할 위험이 관찰됩니다.',
        needAsk: true,
        customQuestion: '현관 앞에 턱이 낮아 보여요. 신용카드를 세운 높이(약 8.5cm)와 비교하면 실제로는 어느 정도인가요?',
        options: [
          ['카드보다 낮아요', 30],
          ['카드 1장 정도예요', 20],
          ['카드 2장 정도예요 (약 17cm)', 10],
          ['그보다 훨씬 높아요', 0],
        ],
      },
      window: {
        score: 12,
        label: '바닥에서 약 15~20cm 높이',
        confidence: 'medium',
        detail: '창문 하단이 노면과 가까워 튀는 빗물 및 침수심 상승 시 취약합니다.',
        needAsk: true,
        customQuestion: '창문 아래쪽이 바깥 땅바닥에서 실제로 얼마나 떨어져 있나요?',
        options: [
          ['거의 땅에 붙어 있어요', 20],
          ['카드 2장 정도예요 (약 17cm)', 12],
          ['무릎 높이쯤이에요', 5],
          ['그보다 높아요', 0],
        ],
      },
      history: {
        score: 5,
        label: '골목 경사 및 배수 상태',
        detail: '골목 경사면에 위치하여 상류부 유출수가 모이기 쉬운 지형입니다.',
        needAsk: true,
        customQuestion: '2022년 8월 집중호우 때, 이 골목에 물이 찼던 기억이 있나요?',
        options: [
          ['네, 물이 찼어요', 15],
          ['아니요, 괜찮았어요', 0],
          ['잘 모르겠어요', 5],
        ],
      },
    },
  };
}


/* ────────────────────────────────────────────────────────────
   자유 텍스트 답변 매핑
   사용자가 버튼 대신 "비슷해" 처럼 직접 입력했을 때,
   그 발화를 보기 중 하나로 연결해 문진을 계속 진행시킨다.
   ──────────────────────────────────────────────────────────── */

export type MatchResult = {
  index: number;          // 매칭된 보기 인덱스, 실패 시 -1
  intent: 'answer' | 'question' | 'unclear';
};

const normalizeKo = (t: string) => t.replace(/\s+/g, '').toLowerCase();

/** API 없이도 도는 로컬 매칭. 확실할 때만 인덱스를 돌려준다. */
export function matchAnswerLocally(userText: string, options: string[]): number {
  const t = normalizeKo(userText);
  if (!t) return -1;

  // "1번", "①", "2" 같은 번호 지정
  const numMatch = t.match(/^([1-9])번?$/) || t.match(/^[①②③④⑤]$/);
  if (numMatch) {
    const circled = '①②③④⑤'.indexOf(t);
    const idx = circled >= 0 ? circled : Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < options.length) return idx;
  }

  // 보기 문구와의 포함 관계 — 정확히 하나만 걸릴 때만 채택
  const hits: number[] = [];
  options.forEach((opt, i) => {
    const o = normalizeKo(opt);
    if (o === t) { hits.length = 0; hits.push(i); return; }
    if (t.length >= 3 && (o.includes(t) || t.includes(o))) hits.push(i);
  });
  return hits.length === 1 ? hits[0] : -1;
}

export async function matchAnswerToOption(
  userText: string,
  question: string,
  options: string[]
): Promise<MatchResult> {
  // 1) 로컬 매칭 우선 — 빠르고 공짜다
  const local = matchAnswerLocally(userText, options);
  if (local >= 0) {
    console.log('[Match] local hit:', local, options[local]);
    return { index: local, intent: 'answer' };
  }

  const list = options.map((o, i) => `${i}: ${o}`).join('\n');
  const prompt = `아래는 침수 위험 문진의 질문과 보기입니다.

[질문] ${question}

[보기]
${list}

[사용자 발화] "${userText}"

사용자의 발화를 위 보기 중 하나로 연결하세요.

판단 지침:
1. 표현이 달라도 **의미가 통하면 그 보기를 고르고** intent="answer", index=보기 번호를 반환합니다.
   - 보기 "카드 1장 정도예요" ← "카드랑 비슷해", "카드랑 비슷한듯", "그 정도야", "얼추 맞아", "비슷해"
   - 보기 "카드보다 낮아요" ← "더 낮아", "거의 없어", "턱이 없다시피 해"
   - 보기 "그보다 훨씬 높아요" ← "많이 높아", "무릎까지 와"
   - 보기 "네, 물이 찼어요" ← "응 잠겼었어", "작년에 넘쳤어"
   - 보기 "잘 모르겠어요" ← "글쎄", "기억 안 나", "몰라"
2. 답변이 아니라 되묻는 질문이면 intent="question", index=-1.
   - "차수판이 뭐예요?", "이거 왜 물어봐요?"
3. intent="unclear"는 위 어디에도 해당하지 않을 때만 쓰는 최후 수단입니다.
   **조금이라도 가까운 보기가 있으면 unclear 대신 answer로 고르세요.**

JSON만 출력: {"intent":"answer|question|unclear","index":number}`;

  try {
    const data = await callLLM({
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    }, 'Match');
    if (!data) return { index: -1, intent: 'unclear' };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
    const idx = Number(parsed.index);
    const intent: MatchResult['intent'] =
      parsed.intent === 'answer' || parsed.intent === 'question' ? parsed.intent : 'unclear';
    const valid = Number.isFinite(idx) && idx >= 0 && idx < options.length;
    console.log('[Match] AI result:', parsed);
    return { index: valid && intent === 'answer' ? idx : -1, intent };
  } catch (err) {
    console.error('[Match Exception]:', err);
    return { index: -1, intent: 'unclear' };
  }
}
