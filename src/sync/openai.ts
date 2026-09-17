/* LLM 호출 세 가지
     Vision   — 사진 세 장에서 판독 가능한 슬롯 값을 미리 읽는다 (확신할 때만)
     Extract  — 자유 텍스트 답변을 슬롯 값 하나로 정리한다 (functions/src/prompt.ts 의 계약)
     Chat     — 문진 중 되물음·결과 화면 후속 대화
   LLM 은 값 추출과 설명만 한다. 위험 판정은 src/utils/diagnose.ts 가 전담한다. */

import {
  SLOT_SPEC, LLM_CONFIG,
  buildSystemPrompt, buildAnswerPrompt, buildExtractionSchema, parseExtraction, extractionFailure,
} from '../../functions/src/prompt';
import type { SlotSpec, ExtractionResult } from '../../functions/src/prompt';
import { ALLOWED } from '../utils/diagnose';
import type { Slots } from '../utils/diagnose';
import { SLOT_PHOTO, SLOTS } from '../content';

export type SlotId = keyof Slots;

/** 사진으로 읽은 슬롯 값 하나 */
export type SlotReading = {
  value: string;                  // ALLOWED[slot] 안의 값만 들어온다
  confidence: 'high' | 'low';     // high 면 문진에서 "맞나요?" 한 줄 확인으로 줄인다
  detail: string;                 // 사진에서 무엇을 보고 그렇게 판단했는지
};

export interface VLMAnalysisResult {
  overview: string;                                   // 사진 전체 총평
  slots: Partial<Record<SlotId, SlotReading>>;        // 사진 판독 대상 슬롯만
}

/* 사진 판독 대상 — 질문 옆에 띄울 사진이 지정된 슬롯 (content.ts SLOT_PHOTO) */
const VISION_SLOTS: SlotSpec[] = SLOT_SPEC.filter((s) => SLOT_PHOTO[s.id as SlotId] !== null);

/* Vision 응답은 10초 안팎이다. 이보다 늦으면 사진 판독 없이 전부 묻는다. */
const VISION_TIMEOUT_MS = 25000;
const CHAT_TIMEOUT_MS = 20000;

/* ────────────────────────────────────────────────────────────
   LLM 호출 경로
   개발(npm run dev): 로컬 .env 키로 OpenAI/OpenRouter 직접 호출
   배포(Firebase Hosting): /api/llm → Cloud Functions 가 서버에서 키를 붙여 호출
   둘 다 불가하거나 제한 시간을 넘기면 null → 호출부가 폴백한다.
   ──────────────────────────────────────────────────────────── */

const PROXY_ENDPOINT = '/api/llm';

type LLMBody = {
  messages: unknown[];
  temperature?: number;
  response_format?: Record<string, unknown>;
};

/* OpenAI 호환 응답에서 우리가 실제로 읽는 부분만 */
type LLMResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: Record<string, unknown>;
};

async function callLLM(body: LLMBody, tag: string, timeoutMs: number): Promise<LLMResponse | null> {
  const key = getApiKey();
  if (!key && import.meta.env.DEV) {
    console.log(`[${tag}] 키 없음 — 시뮬레이션으로 진행`);
    return null;
  }

  /* 느린 응답을 끝까지 기다리면 화면이 멈춘다. 제한 시간이 지나면 끊고 폴백으로 넘긴다. */
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = key
      ? await fetch(getEndpoint(key), {
          method: 'POST',
          headers: getHeaders(key),
          body: JSON.stringify({ ...body, model: getModel(key) }),
          signal: ctrl.signal,
        })
      : await fetch(PROXY_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
    if (!res.ok) {
      console.error(`[${tag}] call failed:`, res.status, await res.text());
      return null;
    }
    return (await res.json()) as LLMResponse;
  } catch (err) {
    if (ctrl.signal.aborted) console.warn(`[${tag}] ${timeoutMs / 1000}초 초과 — 폴백으로 전환`);
    else console.error(`[${tag}] exception:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
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

/* ────────────────────────────────────────────────────────────
   Vision — 사진 판독
   ──────────────────────────────────────────────────────────── */

function normalizeText(raw: unknown, fallback = ''): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

/** AI 원본 JSON 을 판정 엔진이 받아들이는 값으로만 좁힌다.
    허용 값 밖이거나 unknown 이면 확신을 낮춰 문진에서 정식으로 묻게 한다. */
export function normalizeVLM(raw: unknown, address: string): VLMAnalysisResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const src = (r.slots && typeof r.slots === 'object' ? r.slots : {}) as Record<string, unknown>;
  const slots: VLMAnalysisResult['slots'] = {};
  for (const spec of VISION_SLOTS) {
    const id = spec.id as SlotId;
    const f = (src[id] && typeof src[id] === 'object' ? src[id] : {}) as Record<string, unknown>;
    const v = typeof f.value === 'string' && ALLOWED[id].includes(f.value) ? f.value : 'unknown';
    slots[id] = {
      value: v,
      confidence: f.confidence === 'high' && v !== 'unknown' ? 'high' : 'low',
      detail: normalizeText(f.detail, '사진만으로는 판단하기 어려워요.'),
    };
  }
  return {
    overview: normalizeText(
      r.overview,
      `${address ? `[${address}] ` : ''}사진을 살펴봤어요. 몇 가지만 직접 확인할게요.`
    ),
    slots,
  };
}

/**
 * 사진 세 장(현관, 창문, 골목)에서 판독 가능한 슬롯 값을 미리 읽는다.
 * 확신할 수 없는 항목은 unknown/low 로 두고 문진에서 묻는다.
 */
export async function analyzeHousePhotos(
  photos: (string | null)[],
  address: string
): Promise<VLMAnalysisResult> {
  /* 사진이 한 장도 없으면 볼 것이 없다 — 호출하지 않고 전부 묻는다 */
  if (!photos.some(Boolean)) return simulateAnalysis(address);

  const guide = VISION_SLOTS.map((s) => {
    const photo = SLOT_PHOTO[s.id as SlotId] as number;
    const opts = s.options.map((o) => `"${o.value}"(${o.label})`).join(', ');
    return `- ${s.id} — 사진 ${photo + 1}(${SLOTS[photo]})을 보세요.\n  질문: ${s.question}\n  고를 수 있는 값: ${opts}`;
  }).join('\n');

  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };
  const contentParts: ContentPart[] = [
    {
      type: 'text',
      text: `당신은 안양시 반지하 침수 대비 진단 서비스의 사진 판독 도우미입니다.
사용자 주소: "${address || '주소 미입력'}"
사진 1: 현관 문턱, 사진 2: 창문, 사진 3: 집 앞 골목.

아래 항목마다 사진에서 값을 하나 고르세요.
${guide}

[반드시 지킬 규칙]
1. 위에 적힌 값 중 하나만 고릅니다. 새 값을 만들지 않습니다.
2. 사진에서 분명히 보일 때만 confidence 를 "high" 로 둡니다.
   가려졌거나, 각도가 애매하거나, 해당 사진이 없으면 value 는 "unknown", confidence 는 "low" 입니다.
3. 위험도를 판정하지 않습니다. 점수나 등급을 말하지 않습니다.
4. detail 은 사진에서 무엇을 봤는지 한 문장으로 씁니다.
5. overview 는 사진 전체에 대한 2문장 이내의 차분한 설명입니다. 불안을 조성하지 않습니다.

JSON 으로만 응답합니다:
{
  "overview": "…",
  "slots": {
    "<항목 id>": { "value": "…", "confidence": "high" | "low", "detail": "…" }
  }
}`,
    },
  ];

  photos.forEach((photo, idx) => {
    if (!photo) return;
    contentParts.push({ type: 'text', text: `[사진 ${idx + 1}: ${SLOTS[idx]}]` });
    contentParts.push({ type: 'image_url', image_url: { url: photo } });
  });

  try {
    const data = await callLLM({
      messages: [{ role: 'user', content: contentParts }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }, 'Vision', VISION_TIMEOUT_MS);

    const rawContent = data?.choices?.[0]?.message?.content;
    /* 응답이 없거나 늦으면 사진 판독 없이 전부 묻는다 */
    if (!rawContent) return simulateAnalysis(address);
    const parsed = normalizeVLM(JSON.parse(rawContent), address);
    console.log('[VLM Normalized]:', parsed);
    return parsed;
  } catch (err) {
    console.error('[Vision] 분석 실패:', err);
    return simulateAnalysis(address);
  }
}

/** 판독 없이 진행 — 가짜로 확신하지 않는다. 전부 low 라서 모든 항목을 정식으로 묻는다. */
function simulateAnalysis(address: string): VLMAnalysisResult {
  const slots: VLMAnalysisResult['slots'] = {};
  for (const s of VISION_SLOTS) {
    slots[s.id as SlotId] = { value: 'unknown', confidence: 'low', detail: '사진 판독을 하지 못했어요.' };
  }
  return {
    overview: `${address ? `[${address}] ` : ''}사진을 받았어요. 항목마다 직접 여쭤볼게요.`,
    slots,
  };
}

/* ────────────────────────────────────────────────────────────
   자유 텍스트 → 슬롯 값
   1차 로컬 매칭(비용 0) → 2차 LLM 추출(8초 제한). 어느 쪽이든 실패하면 버튼 폴백.
   ──────────────────────────────────────────────────────────── */

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

/**
 * 사용자의 자유 텍스트를 슬롯 값 하나로 정리한다.
 * 결과의 needsFallback 이 true 면 호출부는 선택지 버튼을 계속 보여준다.
 */
export async function extractSlot(slot: SlotSpec, userText: string): Promise<ExtractionResult> {
  const local = matchAnswerLocally(userText, slot.options.map((o) => o.label));
  if (local >= 0) {
    /* 보기 문구를 거의 그대로 말했으면 그 선택을 존중한다 ("잘 모르겠어요" 포함) */
    return { intent: 'answer', value: slot.options[local].value, confidence: 'high', reply: '', needsFallback: false };
  }

  const data = await callLLM({
    messages: [
      { role: 'system', content: buildSystemPrompt(slot) },
      { role: 'user', content: userText },
    ],
    temperature: LLM_CONFIG.temperature,
    response_format: { type: 'json_schema', json_schema: buildExtractionSchema(slot) },
  }, 'Extract', LLM_CONFIG.timeoutMs);

  if (!data) return extractionFailure();
  return parseExtraction(data.choices?.[0]?.message?.content ?? '', slot);
}

/** 문진 도중 되물음("물막이판이 뭐예요?")에 짧게 답한다. 끝에 원래 질문을 다시 안내한다. */
export async function answerSlotQuestion(slot: SlotSpec, userText: string): Promise<string> {
  const data = await callLLM({
    messages: [
      { role: 'system', content: buildAnswerPrompt(slot) },
      { role: 'user', content: userText },
    ],
    temperature: 0.4,
  }, 'Explain', LLM_CONFIG.timeoutMs);
  const text = data?.choices?.[0]?.message?.content?.trim();
  /* 답을 못 받으면 명세의 보충 설명으로 대신한다 */
  return text || `${slot.hint ? slot.hint + ' ' : ''}${slot.question}`;
}

/* ────────────────────────────────────────────────────────────
   결과 화면 후속 대화
   ──────────────────────────────────────────────────────────── */

export async function sendChatMessage(
  history: { role: 'bot' | 'user'; text: string }[],
  userText: string,
  context?: { address?: string; resultSummary?: string }
): Promise<string> {
  const resultNote = context?.resultSummary
    ? `\n\n[이 사용자의 진단 결과]\n${context.resultSummary}\n\n결과를 설명할 때는 위 내용의 항목명과 숫자(cm)를 그대로 인용하고, 없는 항목을 지어내지 마세요. 이 서비스는 점수를 매기지 않으니 "점수"라는 표현을 쓰지 마세요.`
    : '';

  const systemMessage = {
    role: 'system',
    content: `당신은 안양시 반지하 침수 대비 진단 서비스 '잠길까 도우미'입니다.
거주민의 주소: "${context?.address || '미입력'}"${resultNote}
사용자의 질문에 친절하고 쉬운 한국어로 답하세요.
물막이판, 창문 차수막, 역류방지밸브, 안양시 설치 지원, 대피 요령에 대해 도움이 되는 조언을 하세요. 2~3문장으로 간결하게 답하세요.`,
  };

  const formattedHistory = history.map((h) => ({
    role: h.role === 'bot' ? ('assistant' as const) : ('user' as const),
    content: h.text,
  }));

  const data = await callLLM({
    messages: [systemMessage, ...formattedHistory, { role: 'user', content: userText }],
    temperature: 0.7,
  }, 'Chat', CHAT_TIMEOUT_MS);

  if (!data) return '지금은 답변을 불러올 수 없어요. 잠시 후 다시 시도해 주세요.';
  return data.choices?.[0]?.message?.content ?? '확인했습니다.';
}
