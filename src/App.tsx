import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';
import { css } from './css';
import RainCanvas from './RainCanvas';
import { useIsMobile } from './useIsMobile';
import { lookupFlood, getCurrentPosition, coordsFromUrl, locationHelp, GeoError } from './sync/flood';
import { searchAddress, geocodeAddress } from './sync/address';
import FloodMap from './FloodMap';
import type { FloodResult } from './sync/flood';
import { SLOTS, SLOT_PHOTO, SLOT_NAME, STATUS_TONE, EXAMPLES, CONTACT, CONSENT, STATS_NOTE } from './content';
import { analyzeHousePhotos, sendChatMessage, extractSlot, answerSlotQuestion } from './sync/openai';
import type { SlotId } from './sync/openai';
/* 12문항 명세와 판정 엔진 — 차동현 담당 파일. 여기서는 불러 쓰기만 한다. */
import { SLOT_SPEC, UNKNOWN } from '../functions/src/prompt';
import type { SlotSpec } from '../functions/src/prompt';
import { diagnose } from './utils/diagnose';
import type { Slots, DiagnoseResult } from './utils/diagnose';
import { saveDiagnosis, buildPayload, sendStats } from './sync/save';

type Screen = 'landing' | 'upload' | 'chat' | 'result';

/* label 은 저장·요약용 문구, display 는 버튼에만 보이는 문구(확인 질문의 "맞아요") */
type Option = { label: string; value: string; display?: string };

type Message = {
  id?: string;
  role: 'bot' | 'user';
  text: string;
  img?: string | null;
  imgLabel?: string;
  hint?: string;
  options?: Option[];
  qIndex?: number;
  final?: boolean;
};

type DynQuestion = {
  spec: SlotSpec;
  text: string;
  hint?: string;
  options: Option[];
};

/* 판정 상태 → 글자색 */
const TONE_COLOR = {
  danger: 'var(--color-accent-2-700)',
  warn: 'var(--color-accent-2-600)',
  ok: 'var(--color-accent-700)',
  unknown: 'var(--color-neutral-600)',
} as const;
const toneOf = (status: string) => TONE_COLOR[STATUS_TONE[status] ?? 'unknown'];

const CameraIcon = () => (
  <svg width="34" height="34" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path opacity=".25" d="M208 64h-28l-16-24H92L76 64H48a16 16 0 0 0-16 16v112a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V80a16 16 0 0 0-16-16Z"></path><path d="M208 56h-23.7L170.6 35.6A8 8 0 0 0 164 32H92a8 8 0 0 0-6.6 3.6L71.7 56H48a24 24 0 0 0-24 24v112a24 24 0 0 0 24 24h160a24 24 0 0 0 24-24V80a24 24 0 0 0-24-24Zm8 136a8 8 0 0 1-8 8H48a8 8 0 0 1-8-8V80a8 8 0 0 1 8-8h28a8 8 0 0 0 6.6-3.6L96.3 48h63.4l13.7 20.4A8 8 0 0 0 180 72h28a8 8 0 0 1 8 8Zm-88-100a44 44 0 1 0 44 44 44 44 0 0 0-44-44Zm0 72a28 28 0 1 1 28-28 28 28 0 0 1-28 28Z"></path></svg>
);

const DropMark = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 4 C20 4 8 18 8 25 a12 12 0 0 0 24 0 C32 18 20 4 20 4 Z" fill="var(--color-accent)" opacity=".9"></path></svg>
);

const STEPS = [
  { n: '1', title: '집 사진 3장 찍기', body: '현관 턱, 창문, 집 앞 골목. 안내대로 찍으면 됩니다.' },
  { n: '2', title: '몇 가지 질문에 답하기', body: '정확한 진단을 위해 챗봇과 대화하세요' },
  { n: '3', title: '위험 진단 확인', body: '예상 침수지도와 실제 침수 기록으로 물이 들어올 길을 따져 봅니다.' },
  { n: '4', title: '자동화된 지원 접수', body: '차수판·물막이판 설치를 구청에 바로 신청합니다.' },
];

export default function App() {
  const isMobile = useIsMobile();
  /* 데스크톱 스타일 그대로, 모바일 문자열이 주어지면 그걸로 교체 */
  const sx = (desk: string, mob?: string) => css(isMobile && mob !== undefined ? mob : desk);
  /* 모바일 촬영 위저드 단계 (0~2 사진, 3 주소) */
  const [wizardStep, setWizardStep] = useState(0);
  /* 도시침수지도 조회 결과 — 좌표가 있을 때만 채워진다 */
  const [flood, setFlood] = useState<FloodResult | null>(null);
  const [floodPos, setFloodPos] = useState<{ lat: number; lon: number; acc: number } | null>(null);
  const [floodBusy, setFloodBusy] = useState(false);
  const [floodErr, setFloodErr] = useState('');
  const [floodHelp, setFloodHelp] = useState(false);   // 위치 켜는 법을 펼칠지
  const [detail, setDetail] = useState('');            // 상세주소 (지하 1층 등)
  const [addrBusy, setAddrBusy] = useState(false);
  const [screen, setScreen] = useState<Screen>('landing');
  const [photos, setPhotos] = useState<(string | null)[]>([null, null, null]);
  const [address, setAddress] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [waitText, setWaitText] = useState('');
  /* 12슬롯 답변 — 값은 판정 엔진의 Enum, 문구는 결과 요약용 */
  const [slots, setSlots] = useState<Partial<Slots>>({});
  const [slotLabels, setSlotLabels] = useState<Partial<Record<SlotId, string>>>({});
  const [dynQuestions, setDynQuestions] = useState<DynQuestion[]>([]);
  const [consentOpen, setConsentOpen] = useState(false);
  const [c1, setC1] = useState(false);
  const [c2, setC2] = useState(false);
  const [ticket, setTicket] = useState('');
  const [submitBusy, setSubmitBusy] = useState(false);   // 접수 전송 중
  const [submitErr, setSubmitErr] = useState('');        // 접수 실패 사유 — 모달에 그대로 보여준다
  const [inputVal, setInputVal] = useState('');
  /* 결과 화면 전용 대화 — 문진 대화와 분리해서 결과에 대한 후속 질문만 담는다. */
  const [resultChat, setResultChat] = useState<Message[]>([]);
  const [resultInput, setResultInput] = useState('');
  const [resultWaiting, setResultWaiting] = useState(false);
  /* 지금 답을 기다리고 있는 질문. null 이면 자유 대화 모드. */
  const [pending, setPending] = useState<{ i: number; text: string; options: Option[] } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const activeSlot = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /* askDyn 은 useCallback 이라 photos 를 클로저에 가둔다.
     최신 사진을 읽으려면 ref 가 필요하고, 갱신은 렌더가 끝난 뒤에 한다.
     (렌더 중 ref 쓰기는 React 규칙 위반) */
  const photosRef = useRef(photos);
  useEffect(() => { photosRef.current = photos; }, [photos]);
  /* 같은 사진을 질문마다 반복해서 띄우지 않는다 — 처음 나올 때만 크게 보여준다 */
  const shownPhotos = useRef<Set<number>>(new Set());

  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const scrollEnd = () => later(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }), 60);
  const push = (msg: Message) => { setMessages((m) => [...m, msg]); scrollEnd(); };

  const onSendChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = inputVal.trim();
    if (!text || waiting) return;
    setInputVal('');
    push({ role: 'user', text });

    const p = pending;

    /* ── 문진 진행 중: 자유 텍스트를 슬롯 값으로 정리해 그대로 다음 단계로 전진 ── */
    if (p) {
      const q = dynQuestions[p.i];
      /* 되묻는 버튼 목록 — 버튼으로 다시 고르게 해서 흐름이 끊기지 않게 한다 */
      const reask = (text: string) => push({ id: 'q' + p.i, role: 'bot', text, options: p.options, qIndex: p.i });
      if (!q) { reask('아래에서 골라 주세요.'); return; }

      setWaiting(true);
      setWaitText('답변을 이해하는 중…');
      const r = await extractSlot(q.spec, text);   // 8초를 넘기면 버튼 폴백으로 돌아온다
      setWaiting(false);

      if (r.intent === 'answer' && r.value && !r.needsFallback) {
        const label = q.spec.options.find((o) => o.value === r.value)?.label ?? r.value;
        push({ role: 'bot', text: `말씀을 「${label}」(으)로 정리했어요.` });
        commitAnswer(p.i, label, r.value, false);
        return;
      }

      /* 답이 아니라 되물음 → 짧게 설명하고 같은 질문을 다시 띄운다 */
      if (r.intent === 'question') {
        setWaiting(true);
        setWaitText('설명을 준비하는 중…');
        const reply = await answerSlotQuestion(q.spec, text);
        setWaiting(false);
        push({ role: 'bot', text: reply });
        reask('이어서 골라 주세요.');
        return;
      }

      /* 애매하거나, 확신이 낮거나, 시간이 초과된 경우 */
      reask(r.reply || '아래에서 골라 주세요.');
      return;
    }

    /* ── 문진이 끝난 뒤: 일반 상담 대화 ── */
    setWaiting(true);
    setWaitText('잠길까 도우미가 답변을 생성하는 중…');
    try {
      const reply = await sendChatMessage(messages, text, { address });
      setWaiting(false);
      push({ role: 'bot', text: reply });
    } catch {
      setWaiting(false);
      push({ role: 'bot', text: '답변을 불러오는 중 오류가 발생했습니다.' });
    }
  };

  const runWait = useCallback((texts: string[], done: () => void) => {
    let i = 0;
    const tick = () => {
      if (i >= texts.length) { setWaiting(false); done(); return; }
      setWaiting(true); setWaitText(texts[i++]); scrollEnd();
      later(tick, 1400);
    };
    tick();
    /* scrollEnd 는 매 렌더 새로 만들어지지만 하는 일이 같다.
       deps 에 넣으면 runWait 이 매번 재생성되어 진행 중인 타이머가 끊긴다. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const askDyn = useCallback((qs: DynQuestion[], i: number) => {
    if (i >= qs.length) {
      setPending(null);
      runWait(['답변을 모아 판정하는 중…', '침수흔적도와 대조하는 중…'], () => {
        push({ role: 'bot', text: '확인이 모두 끝났어요. 진단 결과를 정리했습니다.', final: true });
      });
      return;
    }
    const q = qs[i];
    const photo = SLOT_PHOTO[q.spec.id as SlotId];
    /* 이 질문과 관련된 사진을 처음 묻는 순간에만 크게 보여준다 */
    const showPhoto = photo !== null && !shownPhotos.current.has(photo);
    if (showPhoto) shownPhotos.current.add(photo);
    setPending({ i, text: q.text, options: q.options });
    push({
      id: 'q' + i,
      role: 'bot',
      text: q.text,
      hint: q.hint,
      ...(showPhoto ? { img: photosRef.current[photo], imgLabel: `올려주신 ${SLOTS[photo].slice(2)} 사진` } : {}),
      options: q.options,
      qIndex: i,
    });
    /* push 도 매 렌더 재생성된다. 넣으면 askDyn 이 계속 바뀌어 문진이 리셋된다. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runWait]);

  /* 버튼 클릭 · 자유 텍스트 · 건너뛰기가 모두 통과하는 단일 진행 경로.
     echoUser=false 는 사용자 말풍선이 이미 찍힌 경우(자유 텍스트). */
  const commitAnswer = (i: number, label: string, value: string, echoUser = true, echoText = label) => {
    const list = dynQuestions;
    const q = list[i];
    if (!q) return;
    const id = q.spec.id as SlotId;
    setPending(null);
    setMessages((ms) => ms.map((m) => (m.id === 'q' + i ? { ...m, options: [] } : m)));
    setSlots((s) => ({ ...s, [id]: value }));
    setSlotLabels((l) => ({ ...l, [id]: label }));
    if (echoUser) push({ role: 'user', text: echoText });

    if (i < list.length - 1) {
      /* 12문항이라 질문 사이 대기 연출은 짧게 둔다 */
      later(() => askDyn(list, i + 1), 450);
    } else {
      runWait(['답변을 모아 판정하는 중…', '침수흔적도와 대조하는 중…'], () => {
        push({ role: 'bot', text: '확인이 모두 끝났어요. 진단 결과를 정리했습니다.', final: true });
      });
    }
  };

  const answer = (i: number, opt: Option) => commitAnswer(i, opt.label, opt.value, true, opt.display ?? opt.label);

  /* 안전망 — 지금 질문을 건너뛰고 다음으로. 판정 엔진은 unknown 을 추측하지 않고 "확인필요"로 둔다. */
  const skipPending = () => {
    const p = pending;
    if (!p || waiting) return;
    commitAnswer(p.i, '잘 모르겠어요 (건너뜀)', UNKNOWN, true);
  };

  const goHome = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    clearTimers();
    setScreen('landing'); setMessages([]); setWaiting(false);
    setSlots({}); setSlotLabels({}); setTicket(''); setConsentOpen(false); setC1(false); setC2(false);
    setSubmitBusy(false); setSubmitErr(''); statsSent.current = false;
    setDynQuestions([]); shownPhotos.current.clear();
    setResultChat([]); setResultInput(''); setResultWaiting(false);
    setFlood(null); setFloodErr(''); setFloodBusy(false); setFloodPos(null); setFloodHelp(false);
    setDetail(''); setAddrBusy(false);
    window.scrollTo(0, 0);
  };

  const startUpload = () => {
    activeSlot.current = 0;
    setWizardStep(0);
    setScreen('upload'); window.scrollTo(0, 0);
    if (!isMobile) fileRef.current?.click();
  };
  const openCamera = (slot: number) => { activeSlot.current = slot; cameraRef.current?.click(); };
  const openAlbum = (slot: number) => { activeSlot.current = slot; fileRef.current?.click(); };

  /* 현재 위치로 침수지도 조회 — 브라우저 위치 권한만 쓰고 외부 키가 필요 없다 */
  const checkFloodByGPS = async () => {
    if (floodBusy) return;
    setFloodBusy(true); setFloodErr(''); setFloodHelp(false); setFlood(null); setFloodPos(null);
    try {
      const { lat, lon, accuracy } = await getCurrentPosition();
      const r = await lookupFlood(lat, lon, true);
      if (r) { setFlood(r); setFloodPos({ lat, lon, acc: accuracy }); }
      else setFloodErr('침수지도를 조회하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } catch (err) {
      setFloodErr(err instanceof Error ? err.message : '위치를 확인하지 못했어요.');
      /* 권한 거부·위치 서비스 꺼짐이면 켜는 법을 바로 펼쳐 준다 */
      if (err instanceof GeoError && (err.kind === 'denied' || err.kind === 'unavailable')) setFloodHelp(true);
    } finally {
      setFloodBusy(false);
    }
  };

  /* 주소 검색 → 좌표 변환 → 침수 판정까지 한 번에 */
  const pickAddress = async () => {
    if (addrBusy || floodBusy) return;
    setFloodErr(''); setFloodHelp(false);
    try {
      const picked = await searchAddress();
      if (!picked) return;
      const base = picked.road || picked.jibun;
      setAddress(base);
      setAddrBusy(true);
      const g = await geocodeAddress(base);
      if (!g?.found || g.lat === undefined || g.lon === undefined) {
        setFloodErr('이 주소의 좌표를 찾지 못했어요. 위치 버튼을 쓰거나 다른 주소로 검색해 주세요.');
        return;
      }
      if (g.refined) setAddress(g.refined);
      setFloodBusy(true); setFlood(null); setFloodPos(null);
      const r = await lookupFlood(g.lat, g.lon, true);
      if (r) { setFlood(r); setFloodPos({ lat: g.lat, lon: g.lon, acc: 0 }); }
      else setFloodErr('침수지도를 조회하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } catch (err) {
      setFloodErr(err instanceof Error ? err.message : '주소를 확인하지 못했어요.');
    } finally {
      setAddrBusy(false); setFloodBusy(false);
    }
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (!files.length) return;
    
    // Base64 변환하여 OpenAI Vision 호환 가능하게 저장
    files.forEach((f, idx) => {
      const slot = activeSlot.current + idx;
      if (slot > 2) return;
      const reader = new FileReader();
      reader.onload = () => {
        setPhotos((prev) => {
          const next = [...prev];
          next[slot] = reader.result as string;
          return next;
        });
      };
      reader.readAsDataURL(f);
    });
    e.target.value = '';
  };

  const n = photos.filter(Boolean).length;

  const startChat = async () => {
    setScreen('chat');
    setMessages([{ role: 'user', text: n ? `사진 ${n}장과 주소를 보냈어요.` : '주소를 보냈어요.' }]);
    window.scrollTo(0, 0);
    setWaiting(true);
    setWaitText(n ? `보내주신 사진 ${n}장을 살펴보는 중…` : '질문을 준비하는 중…');

    shownPhotos.current.clear();
    setSlots({}); setSlotLabels({});

    /* analyzeHousePhotos 는 실패해도 예외를 던지지 않는다 — 판독 없이 전부 low 로 돌아온다 */
    const result = await analyzeHousePhotos(photos, address);
    setWaiting(false);
    push({ role: 'bot', text: result.overview });

    /* 12문항 큐. 사진으로 확신한 항목은 "맞나요?" 한 줄 확인으로 줄이고,
       틀렸으면 바로 고칠 수 있게 나머지 선택지를 함께 보여준다. */
    const qs: DynQuestion[] = SLOT_SPEC.map((spec) => {
      const options: Option[] = spec.options.map((o) => ({ label: o.label, value: o.value }));
      const read = result.slots[spec.id as SlotId];
      if (read?.confidence === 'high') {
        const seen = spec.options.find((o) => o.value === read.value)?.label ?? read.value;
        return {
          spec,
          text: `${SLOT_NAME[spec.id as SlotId]} — 사진에서는 「${seen}」로 보여요. 맞나요?`,
          hint: `사진에서 본 것: ${read.detail}`,
          options: [
            { label: seen, value: read.value, display: '네, 맞아요' },
            ...options.filter((o) => o.value !== read.value),
          ],
        };
      }
      return { spec, text: spec.question, hint: spec.hint, options };
    });

    setDynQuestions(qs);
    askDyn(qs, 0);
  };

  /* 판정 — 슬롯 답변 + 판정용 침수심(예측·실측 중 큰 값).
     침수심을 모르면(위치 미확인, 안양시 밖) null 을 넘겨 경로 A 를 "확인필요"로 둔다. */
  const dx: DiagnoseResult = useMemo(() => {
    const depth = flood?.depthCm ?? null;
    try {
      return diagnose(slots, depth);
    } catch (err) {
      /* 명세(prompt.ts)와 엔진(diagnose.ts)의 허용 값이 어긋나면 여기서 드러난다.
         결과 화면이 통째로 죽지 않도록 어긋난 슬롯을 unknown 으로 보고 다시 판정한다. */
      console.error('[diagnose] 슬롯 값 오류 — 명세와 엔진의 허용 값이 다릅니다:', err);
      return diagnose({}, depth);
    }
  }, [slots, flood]);

  const needsSupport = dx.surface.status === '유입가능'
    || dx.backflow.status === '미흡' || dx.backflow.status === '매우미흡';

  /* 한쪽이라도 확인필요면 "설비가 필요 없다"고 말하지 않는다 — 모르는 것을 안전으로 오해하게 된다 */
  const uncertain = dx.surface.status === '확인필요' || dx.backflow.status === '확인필요';

  /* 결과 한 줄 요약 */
  const headline = needsSupport
    ? '물이 들어올 길이 있어요'
    : uncertain
      ? '확인이 더 필요해요'
      : '지금 구조로는 큰 걱정은 없어요';
  const headlineColor = needsSupport ? TONE_COLOR.danger : uncertain ? TONE_COLOR.unknown : TONE_COLOR.ok;

  /* 판정용 침수심이 어느 채널에서 왔는지 사람이 읽는 문장으로 */
  const depthLines: string[] = [];
  if (flood?.covered) {
    depthLines.push(flood.inMap
      ? `예상 ${flood.predCm}cm · 도시침수지도 50년 빈도 (${flood.seg})`
      : '예상 0cm · 도시침수지도상 침수 예상 구역 아님');
    if (flood.trace?.hit) {
      depthLines.push(`실제 기록 ${flood.traceCm}cm · ${flood.trace.year}년 ${flood.trace.disaster || '호우'} (침수흔적도)`);
    }
  }

  /* 폴리곤 바로 옆이면 판정에는 넣지 않고 경고로만 알린다 */
  const nearTrace = flood?.trace?.near ?? null;
  const warnings = [
    ...(nearTrace ? [`이 골목 약 ${nearTrace.distM}m 거리에 ${nearTrace.year ?? ''}년 ${nearTrace.depthCm}cm 침수 기록이 있어요.`] : []),
    ...dx.warnings,
  ];

  /* 결과 화면에 도달하면 익명 통계를 한 번만 남긴다.
     같은 진단에서 리렌더가 여러 번 일어나도 ref 로 한 번만 보낸다.
     처음으로 돌아가면(goHome) 다시 false 가 되어 다음 진단은 새로 기록된다. */
  const statsSent = useRef(false);
  useEffect(() => {
    if (screen !== 'result' || statsSent.current) return;
    const payload = buildPayload({
      lat: floodPos?.lat ?? flood?.lat ?? null,
      lon: floodPos?.lon ?? flood?.lon ?? null,
      address, detail, flood, slots, dx,
    });
    if (!payload) return;              // 좌표가 없으면 위치 통계로서 의미가 없다
    statsSent.current = true;
    void sendStats(payload);
    /* dx 는 매 렌더 새 객체라 deps 에 넣으면 계속 다시 돈다. 화면 전환만 본다. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  /* 지원 접수 — 동의 두 건을 받은 뒤에만 호출된다.
     서버(/api/save)가 위험 판정·동의·좌표를 다시 검사하고 Firestore 에 남긴 뒤 접수번호를 준다.
     사진은 보내지 않는다. */
  const submitSupport = async () => {
    if (submitBusy) return;
    setSubmitErr('');

    const payload = buildPayload({
      lat: floodPos?.lat ?? flood?.lat ?? null,
      lon: floodPos?.lon ?? flood?.lon ?? null,
      address, detail, flood, slots, dx,
    });
    if (!payload) {
      setSubmitErr('접수하려면 주소나 위치 확인이 필요해요. 처음 화면에서 주소를 먼저 확인해 주세요.');
      return;
    }

    setSubmitBusy(true);
    try {
      const no = await saveDiagnosis(payload);
      setTicket(no);
      setConsentOpen(false);
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : '접수를 저장하지 못했어요.');
    } finally {
      setSubmitBusy(false);
    }
  };

  const onSendResultChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = resultInput.trim();
    if (!text || resultWaiting) return;
    setResultInput('');
    const history = resultChat;
    setResultChat((m) => [...m, { role: 'user', text }]);
    setResultWaiting(true);
    try {
      /* AI가 없는 항목을 지어내지 않도록 판정 결과를 사람이 읽는 문장으로 넘긴다 */
      const answered = SLOT_SPEC
        .filter((sp) => slotLabels[sp.id as SlotId])
        .map((sp) => `- ${SLOT_NAME[sp.id as SlotId]}: ${slotLabels[sp.id as SlotId]}`)
        .join('\n');
      const reply = await sendChatMessage(history, text, {
        address,
        resultSummary: `경로 A 지표 유입: ${dx.surface.status} — ${dx.surface.reason}
판정 침수심: ${dx.floodDepthCm ?? '미확인'}cm${depthLines.length ? ` (${depthLines.join(' / ')})` : ''}
경로 B 역류: ${dx.backflow.status}${dx.backflow.signals.length ? ` — ${dx.backflow.signals.join(' ')}` : ''}
주의할 점: ${warnings.join(' ') || '없음'}
권하는 조치: ${dx.actions.map((a) => `${a.item}(${a.support})`).join(' / ') || '없음'}
사용자 답변:
${answered || '- 없음'}`,
      });
      setResultChat((m) => [...m, { role: 'bot', text: reply }]);
    } catch {
      setResultChat((m) => [...m, { role: 'bot', text: '답변을 불러오는 중 오류가 발생했습니다.' }]);
    } finally {
      setResultWaiting(false);
    }
  };

  /* 주소 검색 블록 — 도로명주소를 고르면 좌표로 바꿔 바로 판정한다 */
  const addressBox = (
    <div style={sx('display:flex;flex-direction:column;gap:10px', 'display:flex;flex-direction:column;gap:8px')}>
      <div style={css('display:flex;gap:8px;align-items:stretch')}>
        <div style={sx('flex:1;min-width:0;border:1px solid var(--color-neutral-200);border-radius:6px;padding:12px 16px;font-size:20px;background:var(--color-surface);display:flex;align-items:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                       'flex:1;min-width:0;border:1px solid var(--color-neutral-200);border-radius:10px;padding:11px 13px;font-size:15px;background:var(--color-surface);display:flex;align-items:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>
          <span style={{ color: address ? 'var(--color-text)' : 'var(--color-neutral-600)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {address || '주소를 검색해 주세요'}
          </span>
        </div>
        <button className="btn btn-primary" onClick={pickAddress} disabled={addrBusy || floodBusy}
          style={sx('font-size:18px;padding:12px 22px;border-radius:6px;font-weight:600;flex:none',
                    'font-size:15px;padding:11px 16px;border-radius:10px;font-weight:600;flex:none')}>
          {addrBusy ? '찾는 중…' : '주소 검색'}
        </button>
      </div>
      {address && (
        <input
          className="input"
          style={sx('font-size:18px;min-height:56px;padding:12px 16px;border-radius:6px;width:100%;box-sizing:border-box',
                    'font-size:15px;min-height:50px;padding:11px 13px;border-radius:10px;width:100%;box-sizing:border-box')}
          placeholder="상세주소 (예: 지하 1층, 101호)"
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
        />
      )}
    </div>
  );

  /* 침수지도 조회 UI — 데스크톱·모바일 주소 입력 옆에 함께 쓴다 */
  const floodBox = (
    <div style={sx('display:flex;flex-direction:column;gap:10px', 'display:flex;flex-direction:column;gap:8px')}>
      <button
        className="btn btn-secondary"
        onClick={checkFloodByGPS}
        disabled={floodBusy}
        style={sx('font-size:19px;padding:14px 20px;min-height:56px;border-radius:8px;border:1.5px solid var(--color-accent-400);background:var(--color-bg);font-weight:400;align-self:flex-start;gap:10px',
                  'font-size:16px;padding:13px 14px;min-height:52px;border-radius:10px;border:1.5px solid var(--color-accent-400);background:var(--color-bg);font-weight:400;width:100%;box-sizing:border-box;gap:8px;justify-content:center')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path><circle cx="12" cy="12" r="8"></circle></svg>
        {floodBusy ? '침수지도 조회 중…' : coordsFromUrl() ? '지정한 위치로 침수 위험 확인하기' : '현재 위치로 침수 위험 확인하기'}
      </button>
      {flood && floodPos && flood.covered && (
        /* 위치가 확인되면 그 자리에서 지도가 펼쳐진다 */
        <div style={css('border:1px solid var(--color-neutral-200);border-radius:12px;overflow:hidden;animation:fadeUp .45s ease both')}>
          <FloodMap
            lat={floodPos.lat}
            lon={floodPos.lon}
            accuracy={floodPos.acc}
            zoom={16}
            height={isMobile ? 200 : 240}
          />
          <div style={css('padding:9px 13px;border-top:1px solid var(--color-neutral-200);font-size:13px;color:var(--color-neutral-700);background:var(--color-bg)')}>
            여기가 우리 집이 맞나요?
          </div>
        </div>
      )}
      {flood && (
        <div style={sx('background:var(--color-accent-100);border-radius:8px;padding:14px 18px;display:flex;flex-direction:column;gap:4px',
                       'background:var(--color-accent-100);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:4px')}>
          <strong style={sx('font-size:19px;color:var(--color-accent-900)', 'font-size:15px;color:var(--color-accent-900)')}>
            {!flood.covered
              ? '판정 범위 밖입니다'
              : flood.inMap
                ? `침수 예상 구역입니다 (예상 ${flood.predCm}cm)`
                : flood.trace?.hit
                  ? `예상 구역은 아니지만 실제 침수 기록이 있습니다 (${flood.traceCm}cm)`
                  : '침수 예상 구역이 아닙니다'}
          </strong>
          <span style={sx('font-size:16px;color:var(--color-neutral-700)', 'font-size:13px;color:var(--color-neutral-700)')}>{flood.label}</span>
          {flood.freq30 && flood.freq50 && (
            <span style={sx('font-size:15px;color:var(--color-neutral-700)', 'font-size:12.5px;color:var(--color-neutral-700)')}>
              30년 빈도 {flood.freq30.inMap ? `침수 (${flood.freq30.seg})` : '해당 없음'} · 50년 빈도 {flood.freq50.inMap ? `침수 (${flood.freq50.seg})` : '해당 없음'}
              {!flood.freq30.inMap && flood.freq50.inMap ? ' — 더 큰 비에는 잠길 수 있어요' : ''}
            </span>
          )}
          {flood.trace?.hit && (
            /* 예측지도와 별개로, 실제로 잠겼던 기록이 있으면 반드시 알려 준다 */
            <span style={sx('font-size:15px;color:var(--color-accent-900);font-weight:600', 'font-size:12.5px;color:var(--color-accent-900);font-weight:600')}>
              이 자리는 {flood.trace.year}년에 실제로 약 {flood.traceCm}cm 잠겼던 기록이 있어요
            </span>
          )}
          {flood.trace?.near && (
            /* 폴리곤 밖이지만 바로 옆 — 판정에는 넣지 않고 알려만 준다 */
            <span style={sx('font-size:15px;color:var(--color-accent-900)', 'font-size:12.5px;color:var(--color-accent-900)')}>
              약 {flood.trace.near.distM}m 거리에 {flood.trace.near.year}년 {flood.trace.near.depthCm}cm 침수 기록이 있어요
            </span>
          )}
          <span style={sx('font-size:14px;color:var(--color-neutral-600)', 'font-size:12px;color:var(--color-neutral-600)')}>
            {flood.source}{flood.seg ? ` · 등급 ${flood.seg}` : ''}
            {coordsFromUrl() ? ' · 지정 좌표(시연)' : ''}
          </span>
          {floodPos && (
            <span style={sx('font-size:13px;color:var(--color-neutral-600);font-variant-numeric:tabular-nums', 'font-size:11px;color:var(--color-neutral-600);font-variant-numeric:tabular-nums')}>
              조회 좌표 {floodPos.lat.toFixed(5)}, {floodPos.lon.toFixed(5)} · 정확도 ±{Math.round(floodPos.acc)}m
            </span>
          )}
        </div>
      )}
      {floodErr && (
        <div style={sx('display:flex;flex-direction:column;gap:10px;background:var(--color-surface);border-radius:8px;padding:14px 18px',
                       'display:flex;flex-direction:column;gap:9px;background:var(--color-surface);border-radius:10px;padding:12px 14px')}>
          <strong style={sx('font-size:17px', 'font-size:15px')}>{floodErr}</strong>
          {floodHelp && (() => {
            const help = locationHelp();
            return (
              <>
                <span style={sx('font-size:14px;color:var(--color-neutral-600)', 'font-size:12px;color:var(--color-neutral-600)')}>{help.device} 기준</span>
                <ol style={sx('margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:15px;color:var(--color-neutral-700)',
                              'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--color-neutral-700)')}>
                  {help.steps.map((t) => <li key={t}>{t}</li>)}
                </ol>
              </>
            );
          })()}
          <div style={css('display:flex;gap:8px;flex-wrap:wrap')}>
            <button className="btn btn-secondary" onClick={checkFloodByGPS} disabled={floodBusy}
              style={sx('font-size:15px;padding:10px 16px;border-radius:8px;border:1.5px solid var(--color-accent-400);background:var(--color-bg);font-weight:400',
                        'font-size:13px;padding:9px 14px;border-radius:8px;border:1.5px solid var(--color-accent-400);background:var(--color-bg);font-weight:400')}>
              다시 시도
            </button>
            {!floodHelp && (
              <button className="btn btn-secondary" onClick={() => setFloodHelp(true)}
                style={sx('font-size:15px;padding:10px 16px;border-radius:8px;border:1.5px solid var(--color-neutral-200);background:var(--color-bg);font-weight:400',
                          'font-size:13px;padding:9px 14px;border-radius:8px;border:1.5px solid var(--color-neutral-200);background:var(--color-bg);font-weight:400')}>
                위치 켜는 법
              </button>
            )}
          </div>
          <span style={sx('font-size:14px;color:var(--color-neutral-600)', 'font-size:12px;color:var(--color-neutral-600)')}>
            위치를 못 켜도 괜찮아요. 주소를 적고 사진 질문만으로도 진단할 수 있습니다.
          </span>
        </div>
      )}
    </div>
  );

  return (
    <div style={css('position:relative;min-height:100vh;display:flex;flex-direction:column;overflow-x:clip')}>
      <header style={sx('display:flex;align-items:center;gap:16px;padding:28px 48px;position:relative;z-index:1;flex-wrap:wrap', 'display:flex;align-items:center;gap:10px;padding:16px 20px 10px;position:relative;z-index:1;flex-wrap:wrap')}>
        <a href="#" onClick={goHome} style={css('display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit')}>
          <svg width={isMobile ? 34 : 44} height={isMobile ? 34 : 44} viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M7 27 Q10 24 14 27 T22 27 T30 27 T33 27 V33 H7 Z" fill="var(--color-accent-200)"></path><path d="M6 20 L20 7 L34 20 V34 H6 Z" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round"></path><path d="M4 26 Q8 23 12 26 T20 26 T28 26 T36 26" stroke="var(--color-accent)" strokeWidth="2.4" strokeLinecap="round"></path></svg>
          <span style={sx('font-weight:700;font-size:30px;letter-spacing:-0.02em;line-height:1', 'font-weight:700;font-size:24px;letter-spacing:-0.02em;line-height:1')}>잠길까</span>
        </a>
        <span style={sx('margin-left:auto;color:var(--color-neutral-600);font-size:17px', 'margin-left:auto;color:var(--color-neutral-600);font-size:12px')}>안양시 반지하 침수 위험 진단 · 시범 서비스</span>
      </header>

      <main style={sx('flex:1;position:relative;z-index:1;width:100%;max-width:1120px;margin:0 auto;padding:0 48px 300px;box-sizing:border-box', 'flex:1;position:relative;z-index:1;width:100%;margin:0 auto;padding:0 20px 140px;box-sizing:border-box')}>
        <input type="file" accept="image/*" multiple ref={fileRef} onChange={onFiles} style={{ display: 'none' }} />
        <input type="file" accept="image/*" capture="environment" ref={cameraRef} onChange={onFiles} style={{ display: 'none' }} />

        {screen === 'landing' && isMobile && (
          <section style={css('display:flex;flex-direction:column;min-height:calc(100dvh - 130px);padding-top:32px;gap:18px')}>
            <div style={css('display:flex;flex-direction:column;gap:14px')}>
              <p style={css('color:var(--color-accent-700);font-size:16px;margin:0')}>비 오는 날, 반지하에 사는 분들을 위해</p>
              <h1 style={css('font-size:clamp(48px,15vw,64px);line-height:1.05;margin:0;letter-spacing:-0.03em')}>오늘,<br />잠길까?</h1>
              <p style={css('font-size:18px;line-height:1.5;color:var(--color-neutral-700);margin:0;text-wrap:pretty')}>사진을 통해<br />우리 집의 침수 위험을 알려드립니다.</p>
            </div>
            <div style={css('margin-top:auto;display:flex;flex-direction:column;gap:12px;padding-bottom:8px')}>
              <details style={css('border-top:1px solid var(--color-neutral-200);padding-top:12px')}>
                <summary style={css('font-size:16px;color:var(--color-accent-700);cursor:pointer;display:flex;justify-content:space-between;align-items:center')}>어떻게 진행되나요? (4단계)<span aria-hidden="true">▾</span></summary>
                <ol style={css('list-style:none;margin:12px 0 4px;padding:0;display:flex;flex-direction:column;gap:12px')}>
                  {STEPS.map((s) => (
                    <li key={s.n} style={css('display:grid;grid-template-columns:30px 1fr;gap:8px;align-items:baseline')}>
                      <span style={css('font-size:24px;line-height:1;color:var(--color-accent);font-weight:600')}>{s.n}</span>
                      <div>
                        <strong style={css('display:block;font-size:16px')}>{s.title}</strong>
                        <span style={css('font-size:14px;color:var(--color-neutral-700)')}>{s.body}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              </details>
              <button className="btn btn-primary" onClick={startUpload} style={css('font-size:19px;line-height:1.3;text-wrap:balance;text-align:left;padding:20px 18px;min-height:84px;border-radius:14px;gap:12px;width:100%;box-sizing:border-box;box-shadow:var(--shadow-md)')}>
                <CameraIcon />
                사진 찍고 침수 위험 확인하기
              </button>
              <p style={css('font-size:13px;color:var(--color-neutral-600);margin:0;text-align:center')}>약 3분 · 회원가입 없음 · 사진은 진단에만 사용됩니다</p>
            </div>
          </section>
        )}

        {screen === 'landing' && !isMobile && (
          <section style={css('display:grid;grid-template-columns:1.1fr 1fr;gap:64px;padding-top:56px;align-items:start')}>
            <div style={css('display:flex;flex-direction:column;gap:22px')}>
              <p style={css('color:var(--color-accent-700);font-size:20px;margin:0')}>비 오는 날, 반지하에 사는 분들을 위해</p>
              <h1 style={css('font-size:76px;line-height:1.1;margin:0;letter-spacing:-0.02em;text-wrap:pretty')}>오늘,<br />잠길까?</h1>
              <p style={css('font-size:24px;line-height:1.5;color:var(--color-neutral-700);max-width:520px;margin:0;text-wrap:pretty')}>사진을 통해 <br />우리 집의 침수 위험을 알려드립니다.</p>
              <button className="btn btn-primary" onClick={startUpload} style={css('font-size:26px;padding:26px 36px;min-height:92px;border-radius:8px;gap:14px;margin-top:14px;align-self:flex-start;text-align:left;box-shadow:var(--shadow-md)')}>
                <CameraIcon />
                사진 첨부하고 침수 위험 확인하기
              </button>
              <p style={css('font-size:17px;color:var(--color-neutral-600);margin:0')}>약 3분 · 회원가입 없음 · 사진은 진단에만 사용됩니다</p>
            </div>
            <ol style={css('list-style:none;margin:0;padding:18px 0 0;display:flex;flex-direction:column;gap:34px')}>
              {STEPS.map((s) => (
                <li key={s.n} style={css('display:grid;grid-template-columns:64px 1fr;gap:14px;align-items:start')}>
                  <span style={css('font-size:52px;line-height:1;color:var(--color-accent);font-weight:600')}>{s.n}</span>
                  <div>
                    <h3 style={css('font-size:26px;margin:0 0 6px')}>{s.title}</h3>
                    <p style={css('margin:0;font-size:19px;color:var(--color-neutral-700);text-wrap:pretty')}>{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {screen === 'upload' && isMobile && (() => {
          /* 0 = 주소·위치, 1~3 = 사진 세 장.
             집을 나서기 전에 위치부터 확정하고 촬영으로 넘어간다. */
          const step = wizardStep;
          const photoIdx = step - 1;
          const ex = EXAMPLES[photoIdx];
          const has = step >= 1 ? photos[photoIdx] : null;
          const titles = ['현관 턱을 찍어 주세요', '창문을 찍어 주세요', '집 앞 골목을 찍어 주세요'];
          const btn = 'font-size:16px;padding:14px 12px;min-height:54px;border-radius:10px;border:1.5px solid var(--color-accent-400);background:var(--color-bg);font-weight:400;flex:1;justify-content:center';
          return (
            <section style={css('padding-top:8px;display:flex;flex-direction:column;gap:14px;min-height:calc(100dvh - 130px)')}>
              {step >= 1 ? (
                <>
                  <div style={css('display:flex;align-items:center;gap:10px;font-size:13px;color:var(--color-neutral-600)')}>
                    <span>{photoIdx + 1} / 3</span>
                    <div style={css('flex:1;height:4px;background:var(--color-neutral-200);border-radius:2px;overflow:hidden')}>
                      <div style={{ width: `${((photoIdx + 1) / 3) * 100}%`, height: '100%', background: 'var(--color-accent)' }} />
                    </div>
                    <span>{SLOTS[photoIdx].slice(2)}</span>
                  </div>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setWizardStep(step - 1)}
                    style={css('all:unset;cursor:pointer;font-size:14px;color:var(--color-accent-700);align-self:flex-start;padding:2px 0')}
                  >
                    ← {step === 1 ? '주소·위치 다시 보기' : '이전 사진으로'}
                  </button>
                  <h2 style={css('font-size:30px;margin:0;letter-spacing:-0.02em;line-height:1.2')}>{titles[photoIdx]}</h2>
                  <p style={css('font-size:16px;color:var(--color-neutral-700);margin:0;text-wrap:pretty')}>{ex.body}</p>
                  <div style={css('border-radius:12px;overflow:hidden;background:var(--color-neutral-200);aspect-ratio:4/4.2;position:relative')}>
                    <img src={has ?? ex.src} alt="" style={css('width:100%;height:100%;object-fit:cover;display:block')} />
                    {!has && <span style={css('position:absolute;left:10px;top:10px;font-size:12px;background:rgba(36,35,31,.72);color:#fff;padding:4px 8px;border-radius:6px')}>예시 사진</span>}
                  </div>
                  <p style={css('font-size:13px;color:var(--color-neutral-600);margin:0')}>{has ? '올린 사진이에요. 다시 찍거나 다음으로 넘어가세요.' : '위 사진처럼 찍으면 AI가 더 정확하게 판단해요.'}</p>
                  <div style={css('margin-top:auto;display:flex;flex-direction:column;gap:10px;padding-bottom:8px')}>
                    {has ? (
                      <>
                        <button className="btn btn-primary" onClick={() => (step >= 3 ? startChat() : setWizardStep(step + 1))} style={css('font-size:20px;padding:20px;min-height:76px;border-radius:14px;width:100%;box-sizing:border-box;box-shadow:var(--shadow-md)')}>{step >= 3 ? '사진 보내고 진단 시작하기' : '다음'}</button>
                        <div style={css('display:flex;gap:8px')}>
                          <button className="btn btn-secondary" onClick={() => openCamera(photoIdx)} style={css(btn)}>다시 찍기</button>
                          <button className="btn btn-secondary" onClick={() => openAlbum(photoIdx)} style={css(btn)}>앨범에서</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-primary" onClick={() => openCamera(photoIdx)} style={css('font-size:20px;padding:20px;min-height:76px;border-radius:14px;gap:12px;width:100%;box-sizing:border-box;box-shadow:var(--shadow-md)')}>
                          <CameraIcon />
                          카메라 열기
                        </button>
                        <div style={css('display:flex;gap:8px')}>
                          <button className="btn btn-secondary" onClick={() => openAlbum(photoIdx)} style={css(btn)}>앨범에서</button>
                          <button className="btn btn-secondary" onClick={() => (step >= 3 ? startChat() : setWizardStep(step + 1))} style={css(btn + ';color:var(--color-neutral-600)')}>{step >= 3 ? '이 사진 없이 진단' : '이 사진 없이'}</button>
                        </div>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p style={css('color:var(--color-accent-700);font-size:15px;margin:0')}>1단계 · 우리 집 위치</p>
                  <h2 style={css('font-size:30px;margin:0;letter-spacing:-0.02em;line-height:1.2')}>집 주소를 알려주세요</h2>
                  <p style={css('font-size:15px;color:var(--color-neutral-700);margin:0')}>주소를 검색하거나, 집에서 접속했다면 위치 버튼을 눌러 주세요. 확인이 끝나면 사진을 찍습니다.</p>
                  <p style={css('font-size:12.5px;line-height:1.5;color:var(--color-neutral-600);margin:0')}>{STATS_NOTE}</p>
                  {addressBox}
                  {floodBox}
                  <div style={css('margin-top:auto;display:flex;flex-direction:column;gap:10px;padding-bottom:8px')}>
                    <button className="btn btn-primary" onClick={() => setWizardStep(1)} style={css('font-size:20px;padding:20px;min-height:76px;border-radius:14px;width:100%;box-sizing:border-box;box-shadow:var(--shadow-md)')}>
                      다음 · 집 사진 찍기
                    </button>
                    <button className="btn btn-secondary" onClick={startChat} style={css('font-size:15px;padding:12px;min-height:48px;border-radius:10px;border:1.5px solid var(--color-neutral-200);background:var(--color-bg);font-weight:400;width:100%;box-sizing:border-box;color:var(--color-neutral-700)')}>
                      사진 없이 질문으로만 진단하기
                    </button>
                  </div>
                </>
              )}
            </section>
          );
        })()}

        {screen === 'upload' && !isMobile && (
          <section style={css('padding-top:16px;display:flex;flex-direction:column;gap:44px')}>
            <div style={css('display:flex;flex-direction:column;gap:10px')}>
              <p style={css('color:var(--color-accent-700);font-size:19px;margin:0')}>1단계 · 사진 올리기</p>
              <h2 style={css('font-size:54px;margin:0;letter-spacing:-0.02em')}>사진 3장을 올려주세요</h2>
              <p style={css('font-size:22px;color:var(--color-neutral-700);margin:0;text-wrap:pretty')}>아래 안내처럼 찍어 주시면 AI가 더 정확하게 판단할 수 있어요.</p>
            </div>

            <div style={css('background:var(--color-surface);border-radius:8px;padding:34px 38px;display:flex;flex-direction:column;gap:26px')}>
              <div style={css('display:flex;align-items:center;gap:12px')}>
                <svg width="30" height="30" viewBox="0 0 256 256" fill="var(--color-accent)" aria-hidden="true"><circle cx="128" cy="128" r="96" opacity=".2"></circle><path d="M128 24a104 104 0 1 0 104 104A104.1 104.1 0 0 0 128 24Zm0 192a88 88 0 1 1 88-88 88.1 88.1 0 0 1-88 88Zm16-40a8 8 0 0 1-8 8 16 16 0 0 1-16-16v-40a8 8 0 0 1 0-16 16 16 0 0 1 16 16v40a8 8 0 0 1 8 8Zm-32-92a12 12 0 1 1 12 12 12 12 0 0 1-12-12Z"></path></svg>
                <h3 style={css('font-size:27px;margin:0')}>이렇게 찍어 주세요</h3>
              </div>
              <div style={css('display:grid;grid-template-columns:repeat(3,1fr);gap:28px')}>
                {EXAMPLES.map((ex) => (
                  <figure key={ex.src} style={css('margin:0;display:flex;flex-direction:column;gap:14px')}>
                    <div style={css('aspect-ratio:4/3;background:var(--color-neutral-200);border-radius:4px;overflow:hidden')}>
                      <img src={ex.src} alt={ex.title} style={css('width:100%;height:100%;object-fit:cover')} />
                    </div>
                    <figcaption style={css('font-size:19px;color:var(--color-text);margin:0;line-height:1.5')}>
                      <strong style={css('display:block;font-size:22px;margin-bottom:4px')}>{ex.title}</strong>{ex.body}
                    </figcaption>
                  </figure>
                ))}
              </div>
              <p style={css('margin:0;font-size:18px;color:var(--color-neutral-700);text-wrap:pretty')}>밝을 때 흔들리지 않게 찍어 주세요. 사진은 진단에만 쓰이고 저장되지 않습니다. {STATS_NOTE}</p>
            </div>

            <div style={css('display:grid;grid-template-columns:repeat(3,1fr);gap:24px')}>
              {SLOTS.map((label, i) => (
                <button
                  key={label}
                  onClick={() => { activeSlot.current = i; fileRef.current?.click(); }}
                  style={css('all:unset;cursor:pointer;display:flex;flex-direction:column;gap:10px;font:inherit;color:inherit;width:100%')}
                >
                  <div style={css('aspect-ratio:4/3;width:100%;border:2px dashed var(--color-accent-400);border-radius:8px;background:var(--color-accent-100);display:grid;place-items:center;overflow:hidden;position:relative')}>
                    {photos[i] ? (
                      <img src={photos[i]} alt="" style={css('position:absolute;inset:0;width:100%;height:100%;object-fit:cover')} />
                    ) : (
                      <div style={css('display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--color-accent-700)')}>
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>
                        <span style={css('font-size:20px')}>눌러서 사진 올리기</span>
                      </div>
                    )}
                  </div>
                  <span style={css('font-size:22px;font-weight:600')}>{label}</span>
                  <span style={css('font-size:17px;color:var(--color-neutral-600)')}>{photos[i] ? '올렸어요 · 눌러서 다시 올리기' : '아직 없어요'}</span>
                </button>
              ))}
            </div>

            <label style={css('display:flex;flex-direction:column;gap:10px;max-width:640px')}>
              <span style={css('font-size:22px;font-weight:600')}>집 주소</span>
              {addressBox}
              <span style={css('font-size:17px;color:var(--color-neutral-600)')}>주소를 검색하면 그 자리의 침수 위험을 바로 조회합니다. 집에서 접속했다면 아래 위치 버튼도 정확해요.</span>
            </label>

            {floodBox}

            <div style={css('display:flex;align-items:center;gap:24px;flex-wrap:wrap')}>
              <button className="btn btn-primary" onClick={startChat} style={css('font-size:26px;padding:24px 40px;min-height:88px;border-radius:8px;box-shadow:var(--shadow-md)')}>사진 보내고 진단 시작하기</button>
              <span style={css('font-size:19px;color:var(--color-neutral-600)')}>
                {n === 3 ? '사진 3장 모두 준비됐어요' : `3장 중 ${n}장 올렸어요 · 사진이 없어도 질문으로 진단할 수 있어요`}
              </span>
            </div>
          </section>
        )}

        {screen === 'chat' && (
          <section style={sx('padding-top:16px;max-width:780px;display:flex;flex-direction:column;gap:32px', 'padding-top:8px;display:flex;flex-direction:column;gap:20px')}>
            <div style={css('display:flex;flex-direction:column;gap:10px')}>
              <p style={sx('color:var(--color-accent-700);font-size:19px;margin:0', 'color:var(--color-accent-700);font-size:15px;margin:0')}>2단계 · 몇 가지 질문</p>
              <h2 style={sx('font-size:46px;margin:0;letter-spacing:-0.02em', 'font-size:26px;margin:0;letter-spacing:-0.02em;line-height:1.25')}>잠길까 도우미가 확인하고 있어요</h2>
              {dynQuestions.length > 0 && (() => {
                const done = Object.keys(slots).length;
                return (
                  <div role="progressbar" aria-valuemin={0} aria-valuemax={dynQuestions.length} aria-valuenow={done}
                    style={css('display:flex;align-items:center;gap:12px;margin-top:4px')}>
                    <div style={css('flex:1;height:8px;border-radius:4px;background:var(--color-neutral-200);overflow:hidden')}>
                      <div style={{ height: '100%', width: `${(done / dynQuestions.length) * 100}%`, background: 'var(--color-accent)', borderRadius: 4, transition: 'width .35s ease' }} />
                    </div>
                    <span style={sx('font-size:17px;color:var(--color-neutral-700);font-variant-numeric:tabular-nums', 'font-size:13px;color:var(--color-neutral-700);font-variant-numeric:tabular-nums')}>{done} / {dynQuestions.length}</span>
                  </div>
                );
              })()}
            </div>
            <div style={css('display:flex;flex-direction:column;gap:26px')}>
              {messages.map((m, idx) => (
                <div key={idx} style={css('display:flex;flex-direction:column;animation:fadeUp .4s ease both')}>
                  {m.role === 'bot' ? (
                    <div style={css('display:flex;gap:16px;align-items:flex-start')}>
                      <div style={sx('width:44px;height:44px;border-radius:50%;background:var(--color-accent-200);display:grid;place-items:center;flex:none;margin-top:4px', 'width:34px;height:34px;border-radius:50%;background:var(--color-accent-200);display:grid;place-items:center;flex:none;margin-top:2px')}>
                        <DropMark size={isMobile ? 18 : 24} />
                      </div>
                      <div style={sx('display:flex;flex-direction:column;gap:16px;max-width:640px;flex:1', 'display:flex;flex-direction:column;gap:12px;flex:1;min-width:0')}>
                        {m.img && <img src={m.img} alt="" style={sx('width:100%;max-height:320px;object-fit:cover;border-radius:8px', 'width:100%;max-height:200px;object-fit:cover;border-radius:10px')} />}
                        {'img' in m && !m.img && (
                          <div style={sx('height:220px;border-radius:8px;background:var(--color-neutral-200);display:grid;place-items:center;color:var(--color-neutral-600);font-size:18px;text-align:center;padding:20px', 'height:130px;border-radius:10px;background:var(--color-neutral-200);display:grid;place-items:center;color:var(--color-neutral-600);font-size:14px;text-align:center;padding:16px')}>{m.imgLabel}</div>
                        )}
                        <p style={sx('margin:0;font-size:23px;line-height:1.5;text-wrap:pretty', 'margin:0;font-size:17px;line-height:1.5;text-wrap:pretty')}>{m.text}</p>
                        {m.hint && !!m.options?.length && (
                          <p style={sx('margin:-8px 0 0;font-size:17px;line-height:1.5;color:var(--color-neutral-600);text-wrap:pretty', 'margin:-6px 0 0;font-size:13.5px;line-height:1.5;color:var(--color-neutral-600);text-wrap:pretty')}>{m.hint}</p>
                        )}
                        {!!m.options?.length && (
                          <div style={css('display:flex;flex-direction:column;gap:10px')}>
                            {m.options.map((opt) => (
                              <button
                                key={opt.value}
                                className="btn btn-secondary"
                                onClick={() => answer(m.qIndex as number, opt)}
                                style={sx('font-size:21px;padding:16px 22px;min-height:64px;justify-content:flex-start;border:1.5px solid var(--color-accent-400);border-radius:8px;background:var(--color-bg);font-weight:400', 'font-size:16px;padding:13px 16px;min-height:54px;justify-content:flex-start;border:1.5px solid var(--color-accent-400);border-radius:10px;background:var(--color-bg);font-weight:400;text-align:left')}
                              >
                                {opt.display ?? opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                        {m.final && (
                          <button className="btn btn-primary" onClick={() => { setScreen('result'); window.scrollTo(0, 0); }} style={sx('font-size:24px;padding:20px 36px;min-height:76px;border-radius:8px;align-self:flex-start;box-shadow:var(--shadow-md)', 'font-size:19px;padding:18px 24px;min-height:66px;border-radius:12px;width:100%;box-sizing:border-box;box-shadow:var(--shadow-md)')}>결과 보기</button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={sx('align-self:flex-end;background:var(--color-accent-100);color:var(--color-accent-900);padding:14px 22px;border-radius:16px 16px 4px 16px;font-size:21px;max-width:70%', 'align-self:flex-end;background:var(--color-accent-100);color:var(--color-accent-900);padding:10px 16px;border-radius:14px 14px 3px 14px;font-size:16px;max-width:85%')}>{m.text}</div>
                  )}
                </div>
              ))}
              {waiting && (
                <div style={css('display:flex;gap:16px;align-items:center;animation:fadeUp .4s ease both')}>
                  <div style={css('width:44px;height:44px;border-radius:50%;background:var(--color-accent-200);display:grid;place-items:center;flex:none')}>
                    <DropMark />
                  </div>
                  <p style={sx('margin:0;font-size:22px;color:var(--color-neutral-700);font-style:italic', 'margin:0;font-size:15px;color:var(--color-neutral-700);font-style:italic')}>{waitText}</p>
                  <span style={css('display:inline-flex;gap:5px;margin-left:2px')}>
                    {[0, 0.2, 0.4].map((d: number) => (
                      <i key={d} style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-accent)', animation: `blink 1.2s ${d}s infinite` }} />
                    ))}
                  </span>
                </div>
              )}
            </div>

            {/* 실시간 자유 대화 입력창 */}
            <form
              onSubmit={onSendChat}
              style={sx('display:flex;gap:12px;position:sticky;bottom:32px;background:var(--color-bg);padding:14px 18px;border:2px solid var(--color-accent-400);border-radius:12px;box-shadow:var(--shadow-md);z-index:10;margin-top:12px', 'display:flex;gap:8px;position:sticky;bottom:12px;background:var(--color-bg);padding:8px 8px 8px 14px;border:1.5px solid var(--color-accent-400);border-radius:14px;box-shadow:var(--shadow-md);z-index:10;margin-top:4px;align-items:center')}
            >
              <input
                type="text"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder={pending ? '보기를 눌러도 되고, 이렇게 직접 답해도 돼요…' : '침수 위험, 지원 사업, 대피 요령 등 AI에게 무엇이든 물어보세요…'}
                disabled={waiting}
                style={sx('flex:1;border:none;background:transparent;font-size:20px;color:var(--color-text);outline:none;font-family:inherit', 'flex:1;border:none;background:transparent;font-size:16px;color:var(--color-text);outline:none;font-family:inherit;min-width:0')}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={waiting || !inputVal.trim()}
                style={sx('font-size:19px;padding:12px 28px;border-radius:8px;font-weight:600', 'font-size:15px;padding:10px 16px;border-radius:9px;font-weight:600')}
              >
                전송
              </button>
            </form>

            {/* 안전망 — 흐름이 어디서 막혀도 손으로 빠져나갈 수 있게 */}
            <div style={sx('display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:-8px', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:-4px')}>
              {pending && (
                <button
                  className="btn btn-secondary"
                  onClick={skipPending}
                  disabled={waiting}
                  style={sx('font-size:17px;padding:10px 18px;border-radius:8px;border:1.5px solid var(--color-accent-400);background:var(--color-bg);font-weight:400', 'font-size:13px;padding:7px 12px;border-radius:8px;border:1.5px solid var(--color-accent-400);background:var(--color-bg);font-weight:400')}
                >
                  이 질문 건너뛰기
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={() => { clearTimers(); setWaiting(false); setPending(null); setScreen('result'); window.scrollTo(0, 0); }}
                style={sx('font-size:17px;padding:10px 18px;border-radius:8px;border:1.5px solid var(--color-accent-400);background:var(--color-bg);font-weight:400', 'font-size:13px;padding:7px 12px;border-radius:8px;border:1.5px solid var(--color-accent-400);background:var(--color-bg);font-weight:400')}
              >
                지금까지 결과 보기
              </button>
              <span style={sx('font-size:16px;color:var(--color-neutral-600)', 'font-size:12px;color:var(--color-neutral-600)')}>
                {pending ? `${pending.i + 1} / ${dynQuestions.length} 번째 질문` : dynQuestions.length ? '문진 완료' : ''}
              </span>
            </div>
          </section>
        )}

        {screen === 'result' && (
          <section style={sx('padding-top:16px;display:flex;flex-direction:column;gap:56px', 'padding-top:0;display:flex;flex-direction:column;gap:30px')}>
            {isMobile && (
              /* 스크롤해도 두 경로의 판정이 상단에 붙어 있다 */
              <div style={css('position:sticky;top:0;z-index:5;background:var(--color-bg);padding:10px 0;border-bottom:1px solid var(--color-neutral-200);display:flex;gap:8px;flex-wrap:wrap')}>
                {([['지표 유입', dx.surface.status], ['역류', dx.backflow.status]] as const).map(([k, st]) => (
                  <span key={k} style={css(`font-size:14px;font-weight:600;padding:6px 12px;border-radius:999px;border:1.5px solid ${toneOf(st)};color:${toneOf(st)}`)}>{k} · {st}</span>
                ))}
              </div>
            )}
            <div style={sx('display:flex;flex-direction:column;gap:14px;max-width:820px', 'display:flex;flex-direction:column;gap:10px')}>
              <p style={sx('color:var(--color-accent-700);font-size:19px;margin:0', 'color:var(--color-accent-700);font-size:15px;margin:0')}>3단계 · 진단 결과</p>
              <h2 style={sx(`font-size:54px;margin:0;letter-spacing:-0.02em;color:${headlineColor}`,
                            `font-size:28px;margin:0;letter-spacing:-0.02em;line-height:1.25;color:${headlineColor}`)}>{headline}</h2>
              <p style={sx('font-size:21px;line-height:1.55;color:var(--color-neutral-700);margin:0;text-wrap:pretty', 'font-size:15px;line-height:1.55;color:var(--color-neutral-700);margin:0;text-wrap:pretty')}>
                반지하에 물이 들어오는 길은 두 가지예요. 바깥 빗물이 문·창문을 넘는 <b>지표 유입</b>, 하수관 물이 배수구로 올라오는 <b>역류</b>. 막는 설비가 서로 달라서 따로 판정했어요.
              </p>
              {!dx.quality.reliable && (
                <p style={sx(`font-size:18px;margin:0;color:${TONE_COLOR.warn}`, `font-size:14px;margin:0;color:${TONE_COLOR.warn}`)}>
                  모르는 항목이 {dx.quality.unknownCount}개라 판정이 불확실해요. 확인되는 대로 다시 진단해 주세요.
                </p>
              )}
            </div>

            <div style={sx('display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:stretch', 'display:flex;flex-direction:column;gap:14px')}>
              {/* 경로 A — 예상 침수심과 가장 약한 개구부의 방어높이를 뺄셈으로 비교 */}
              <article style={sx(`background:var(--color-surface);border-radius:12px;display:flex;flex-direction:column;gap:12px;padding:28px 30px;border-top:4px solid ${toneOf(dx.surface.status)}`,
                                 `background:var(--color-surface);border-radius:12px;display:flex;flex-direction:column;gap:9px;padding:18px 18px;border-top:4px solid ${toneOf(dx.surface.status)}`)}>
                <span style={sx('font-size:17px;color:var(--color-neutral-600)', 'font-size:13px;color:var(--color-neutral-600)')}>경로 A · 지표 유입</span>
                <strong style={sx(`font-size:40px;line-height:1.1;color:${toneOf(dx.surface.status)}`, `font-size:28px;line-height:1.1;color:${toneOf(dx.surface.status)}`)}>{dx.surface.status}</strong>
                <p style={sx('margin:0;font-size:18px;line-height:1.5;text-wrap:pretty', 'margin:0;font-size:14.5px;line-height:1.5;text-wrap:pretty')}>{dx.surface.reason}</p>
                <dl style={sx('margin:4px 0 0;display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:17px', 'margin:2px 0 0;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:14px')}>
                  <dt style={css('color:var(--color-neutral-600)')}>판정 침수심</dt>
                  <dd style={css('margin:0')}>
                    <b>{dx.floodDepthCm !== null ? `${dx.floodDepthCm}cm` : '미확인'}</b>
                    {depthLines.map((l) => (
                      <span key={l} style={sx('display:block;font-size:15px;color:var(--color-neutral-700)', 'display:block;font-size:12.5px;color:var(--color-neutral-700)')}>{l}</span>
                    ))}
                    {flood?.basis === 'trace' && (
                      <span style={sx(`display:block;font-size:15px;color:${TONE_COLOR.danger}`, `display:block;font-size:12.5px;color:${TONE_COLOR.danger}`)}>예상 지도에는 빠져 있지만 실제로 잠겼던 깊이로 판정했어요.</span>
                    )}
                  </dd>
                  {dx.surface.weakestPoint && (
                    <>
                      <dt style={css('color:var(--color-neutral-600)')}>가장 약한 곳</dt>
                      <dd style={css('margin:0')}>{dx.surface.weakestPoint} · 방어높이 {dx.surface.effectiveDefenseCm}cm</dd>
                    </>
                  )}
                  {/* 침수심 - 방어높이 차이값은 표시하지 않는다.
                      실내 유입 깊이가 아니고(반지하는 실내 바닥이 지면보다 낮다),
                      침수심 자체가 가정값이라 1cm 단위 표기는 없는 정밀도를 주장한다.
                      위 두 줄에 침수심과 방어높이가 각각 있으므로 비교는 그대로 읽힌다. */}
                </dl>
                {!flood && (
                  <p style={sx('margin:0;font-size:15px;color:var(--color-neutral-600)', 'margin:0;font-size:12.5px;color:var(--color-neutral-600)')}>1단계에서 주소나 위치를 확인하면 침수심을 넣어 판정할 수 있어요.</p>
                )}
              </article>

              {/* 경로 B — 확률은 내지 않는다. 막는 장치가 있는지, 전조가 보이는지만 센다 */}
              <article style={sx(`background:var(--color-surface);border-radius:12px;display:flex;flex-direction:column;gap:12px;padding:28px 30px;border-top:4px solid ${toneOf(dx.backflow.status)}`,
                                 `background:var(--color-surface);border-radius:12px;display:flex;flex-direction:column;gap:9px;padding:18px 18px;border-top:4px solid ${toneOf(dx.backflow.status)}`)}>
                <span style={sx('font-size:17px;color:var(--color-neutral-600)', 'font-size:13px;color:var(--color-neutral-600)')}>경로 B · 역류</span>
                <strong style={sx(`font-size:40px;line-height:1.1;color:${toneOf(dx.backflow.status)}`, `font-size:28px;line-height:1.1;color:${toneOf(dx.backflow.status)}`)}>{dx.backflow.status}</strong>
                {dx.backflow.signals.length ? (
                  <ul style={sx('margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:18px;line-height:1.5', 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:14.5px;line-height:1.5')}>
                    {dx.backflow.signals.map((sg) => <li key={sg}>{sg}</li>)}
                  </ul>
                ) : (
                  <p style={sx('margin:0;font-size:18px;line-height:1.5', 'margin:0;font-size:14.5px;line-height:1.5')}>
                    {dx.backflow.status === '확인필요' ? '역류 관련 항목을 확인하지 못했어요.' : '확인된 역류 신호가 없어요.'}
                  </p>
                )}
                <p style={sx('margin:0;font-size:15px;color:var(--color-neutral-600)', 'margin:0;font-size:12.5px;color:var(--color-neutral-600)')}>물막이판으로는 역류를 막을 수 없어요. 역류는 역류방지밸브로 막습니다.</p>
              </article>
            </div>

            {floodPos && flood && flood.covered && (
              /* 결과 화면 — 같은 지도에 침수 레이어가 차오르고 판정 침수심이 새겨진다 */
              <div style={css('display:flex;flex-direction:column;gap:10px')}>
                <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>내 위치의 침수 위험</h3>
                <div style={css('border:1px solid var(--color-neutral-200);border-radius:12px;overflow:hidden')}>
                  <FloodMap
                    lat={floodPos.lat}
                    lon={floodPos.lon}
                    accuracy={floodPos.acc}
                    shapes={flood.shapes?.freq50 ?? flood.shapes?.freq30}
                    traces={flood.shapes?.trace}
                    badge={{ seg: flood.seg, depthCm: flood.depthCm, basis: flood.basis }}
                    overlay
                    zoom={16}
                    height={isMobile ? 210 : 300}
                  />
                </div>
                <p style={sx('font-size:16px;color:var(--color-neutral-700);margin:0', 'font-size:13px;color:var(--color-neutral-700);margin:0')}>
                  파란 면은 예상 침수 구역이고, 진할수록 깊습니다. {flood.freq30 && flood.freq50 && !flood.freq30.inMap && flood.freq50.inMap
                    ? '30년 빈도에는 안전하지만 50년 빈도 강우에는 침수 예상 구역에 들어갑니다.'
                    : '50년 빈도 강우 기준으로 표시했습니다.'}
                </p>
                {flood.shapes?.trace?.length ? (
                  <p style={sx('font-size:16px;color:var(--color-neutral-700);margin:0', 'font-size:13px;color:var(--color-neutral-700);margin:0')}>
                    <b style={{ color: '#b4452f' }}>붉은 점선</b>은 실제로 물이 찼던 기록이 남은 구역입니다.
                    {flood.trace?.hit && !flood.inMap
                      ? ' 예상 지도에는 빠져 있지만, 여기는 실제로 잠겼던 자리예요.'
                      : ''}
                  </p>
                ) : null}
              </div>
            )}

            <div style={sx('display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:start', 'display:flex;flex-direction:column;gap:28px')}>
              <div style={css('display:flex;flex-direction:column;gap:18px')}>
                <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>지금 할 수 있는 대비</h3>
                {dx.actions.length ? (
                  <ul style={css('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:18px')}>
                    {dx.actions.map((a) => (
                      <li key={a.item} style={css('display:flex;flex-direction:column;gap:3px')}>
                        <strong style={sx('font-size:21px', 'font-size:16px')}>{a.item}</strong>
                        <span style={sx('font-size:18px;color:var(--color-neutral-700);text-wrap:pretty', 'font-size:14px;color:var(--color-neutral-700);text-wrap:pretty')}>{a.detail}</span>
                        {/* 안양시 지원 여부 — 미지원 품목은 붉게 표시해 오해가 없게 한다 */}
                        <span style={sx(`font-size:16px;color:${a.support.includes('지원 대상') ? TONE_COLOR.ok : TONE_COLOR.danger}`,
                                        `font-size:13px;color:${a.support.includes('지원 대상') ? TONE_COLOR.ok : TONE_COLOR.danger}`)}>{a.support}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p style={sx('margin:0;font-size:18px;color:var(--color-neutral-700)', 'margin:0;font-size:14px;color:var(--color-neutral-700)')}>{uncertain ? '확인하지 못한 항목이 있어 권할 설비를 정하지 못했어요.' : '지금 답변으로는 따로 설치할 설비가 없어요.'}</p>
                )}
              </div>
              <div style={css('display:flex;flex-direction:column;gap:18px')}>
                <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>주의할 점</h3>
                {warnings.length ? (
                  <ul style={sx('margin:0;padding-left:22px;display:flex;flex-direction:column;gap:10px;font-size:18px;line-height:1.5;color:var(--color-neutral-700)', 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:1.5;color:var(--color-neutral-700)')}>
                    {warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                ) : (
                  <p style={sx('margin:0;font-size:18px;color:var(--color-neutral-700)', 'margin:0;font-size:14px;color:var(--color-neutral-700)')}>{uncertain ? '확인된 항목 안에서는 주의할 점이 없어요.' : '특별히 주의할 점은 없어요.'}</p>
                )}
              </div>
            </div>

            <div style={sx('display:flex;flex-direction:column;gap:14px;max-width:820px', 'display:flex;flex-direction:column;gap:10px')}>
              <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>비가 많이 올 때</h3>
              <ol style={sx('margin:0;padding-left:24px;display:flex;flex-direction:column;gap:8px;font-size:19px;line-height:1.5', 'margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:14.5px;line-height:1.5')}>
                {dx.rainGuide.map((g) => <li key={g}>{g}</li>)}
              </ol>
            </div>

            <details style={sx('max-width:820px;font-size:18px', 'font-size:14px')}>
              <summary style={css('cursor:pointer;color:var(--color-accent-700)')}>내가 답한 항목 {Object.keys(slotLabels).length}개 보기</summary>
              <dl style={sx('margin:14px 0 0;display:grid;grid-template-columns:auto 1fr;gap:8px 20px', 'margin:10px 0 0;display:grid;grid-template-columns:auto 1fr;gap:6px 14px')}>
                {SLOT_SPEC.filter((sp) => slotLabels[sp.id as SlotId]).map((sp) => (
                  <div key={sp.id} style={{ display: 'contents' }}>
                    <dt style={css('color:var(--color-neutral-600)')}>{SLOT_NAME[sp.id as SlotId]}</dt>
                    <dd style={css('margin:0')}>{slotLabels[sp.id as SlotId]}</dd>
                  </div>
                ))}
              </dl>
            </details>

            {needsSupport && (
              <div style={sx('background:var(--color-surface);padding:38px 42px;border-radius:8px;display:grid;grid-template-columns:1fr auto;gap:36px;align-items:center', 'background:var(--color-surface);padding:20px 18px;border-radius:12px;display:flex;flex-direction:column;gap:16px')}>
                <div style={css('display:flex;flex-direction:column;gap:12px')}>
                  <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>지원이 필요한 수준이에요</h3>
                  <p style={sx('font-size:20px;margin:0;color:var(--color-neutral-700);text-wrap:pretty', 'font-size:14px;margin:0;color:var(--color-neutral-700);text-wrap:pretty')}>안양시 담당 부서에 직접 연락하거나, 버튼 하나로 바로 접수할 수 있어요. 접수하면 담당 공무원이 우선순위를 검토해 창문 차수막 같은 지원 품목 설치를 안내합니다.</p>
                  <p style={sx('font-size:32px;font-weight:600;margin:6px 0 0;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap', 'font-size:22px;font-weight:600;margin:4px 0 0;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap')}>
                    {CONTACT.phone} <span style={css('font-size:17px;font-weight:400;color:var(--color-neutral-600)')}>{CONTACT.dept}</span>
                  </p>
                </div>
                {ticket ? (
                  <div style={sx('display:flex;flex-direction:column;gap:6px;text-align:right', 'display:flex;flex-direction:column;gap:4px')}>
                    <span style={css('font-size:26px;font-weight:600;color:var(--color-accent-700)')}>접수 완료</span>
                    <span style={css('font-size:19px')}>접수번호 {ticket}</span>
                    <span style={css('font-size:17px;color:var(--color-neutral-600)')}>담당 공무원이 확인 후 연락드립니다.</span>
                  </div>
                ) : (
                  <button className="btn btn-primary" onClick={() => setConsentOpen(true)} style={sx('font-size:25px;padding:24px 36px;min-height:88px;border-radius:8px;box-shadow:var(--shadow-md)', 'font-size:19px;padding:18px;min-height:68px;border-radius:12px;width:100%;box-sizing:border-box;box-shadow:var(--shadow-md)')}>자동으로 지원 접수하기</button>
                )}
              </div>
            )}

            {!needsSupport && (
              <p style={sx('font-size:20px;color:var(--color-neutral-700);margin:0;text-wrap:pretty', 'font-size:15px;color:var(--color-neutral-700);margin:0;text-wrap:pretty')}>{uncertain
                ? '확인하지 못한 항목이 있어 지원 필요 여부를 확정하지 못했어요. 확인되는 대로 다시 진단해 주세요.'
                : '지금 답변으로는 설치 지원이 필요한 수준은 아니에요. 큰 비 예보가 있으면 다시 확인해 주세요.'}</p>
            )}

            {/* 결과에 대한 후속 대화 */}
            <div style={css('display:flex;flex-direction:column;gap:22px;max-width:780px')}>
              <div style={css('display:flex;flex-direction:column;gap:6px')}>
                <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>결과에 대해 더 물어보기</h3>
                <p style={sx('font-size:18px;color:var(--color-neutral-700);margin:0', 'font-size:14px;color:var(--color-neutral-700);margin:0')}>판정 근거, 대비책, 지원 사업 등 궁금한 것을 잠길까 도우미에게 물어보세요.</p>
              </div>
              {resultChat.length > 0 && (
                <div style={css('display:flex;flex-direction:column;gap:18px')}>
                  {resultChat.map((m, idx) => (
                    <div key={idx} style={css('display:flex;flex-direction:column;animation:fadeUp .4s ease both')}>
                      {m.role === 'bot' ? (
                        <div style={css('display:flex;gap:14px;align-items:flex-start')}>
                          <div style={css('width:40px;height:40px;border-radius:50%;background:var(--color-accent-200);display:grid;place-items:center;flex:none;margin-top:2px')}>
                            <DropMark size={22} />
                          </div>
                          <p style={sx('margin:0;font-size:20px;line-height:1.55;text-wrap:pretty;max-width:640px', 'margin:0;font-size:16px;line-height:1.5;text-wrap:pretty')}>{m.text}</p>
                        </div>
                      ) : (
                        <div style={sx('align-self:flex-end;background:var(--color-accent-100);color:var(--color-accent-900);padding:12px 20px;border-radius:16px 16px 4px 16px;font-size:19px;max-width:70%', 'align-self:flex-end;background:var(--color-accent-100);color:var(--color-accent-900);padding:10px 16px;border-radius:14px 14px 3px 14px;font-size:16px;max-width:85%')}>{m.text}</div>
                      )}
                    </div>
                  ))}
                  {resultWaiting && (
                    <div style={css('display:flex;gap:14px;align-items:center')}>
                      <div style={css('width:40px;height:40px;border-radius:50%;background:var(--color-accent-200);display:grid;place-items:center;flex:none')}><DropMark size={22} /></div>
                      <span style={css('display:inline-flex;gap:5px')}>
                        {[0, 0.2, 0.4].map((d: number) => (
                          <i key={d} style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-accent)', animation: `blink 1.2s ${d}s infinite` }} />
                        ))}
                      </span>
                    </div>
                  )}
                </div>
              )}
              <form
                onSubmit={onSendResultChat}
                style={sx('display:flex;gap:12px;background:var(--color-bg);padding:14px 18px;border:2px solid var(--color-accent-400);border-radius:12px;box-shadow:var(--shadow-md)', 'display:flex;gap:8px;background:var(--color-bg);padding:8px 8px 8px 14px;border:1.5px solid var(--color-accent-400);border-radius:14px;box-shadow:var(--shadow-md);align-items:center')}
              >
                <input
                  type="text"
                  value={resultInput}
                  onChange={(e) => setResultInput(e.target.value)}
                  placeholder="예) 왜 창문으로 물이 들어온다고 나왔나요? 역류방지밸브는 어디서 사나요?"
                  disabled={resultWaiting}
                  style={sx('flex:1;border:none;background:transparent;font-size:19px;color:var(--color-text);outline:none;font-family:inherit;min-width:0', 'flex:1;border:none;background:transparent;font-size:16px;color:var(--color-text);outline:none;font-family:inherit;min-width:0')}
                />
                <button type="submit" className="btn btn-primary" disabled={resultWaiting || !resultInput.trim()} style={sx('font-size:18px;padding:12px 24px;border-radius:8px;font-weight:600', 'font-size:15px;padding:10px 16px;border-radius:9px;font-weight:600')}>전송</button>
              </form>
            </div>

            <p style={sx('margin:0;font-size:15px;line-height:1.6;color:var(--color-neutral-600);max-width:780px', 'margin:0;font-size:12.5px;line-height:1.6;color:var(--color-neutral-600)')}>
              {STATS_NOTE}{ticket ? ' 접수하신 건은 동의하신 범위에서 주소와 함께 안양시에 전달됩니다.' : ''}
            </p>
            <a href="#" onClick={goHome} style={css('font-size:20px;align-self:flex-start')}>처음으로 돌아가기</a>
          </section>
        )}

        {consentOpen && (() => {
          /* 개인정보 고지 — 항목·목적·기간·거부권을 모두 보여준 뒤 개별 동의를 받는다.
             문구는 content.ts 의 CONSENT 한 곳에서만 고친다. */
          const checks = [c1, c2];
          const setChecks = [setC1, setC2];
          const allAgreed = checks.every(Boolean);
          const cbStyle = css('width:24px;height:24px;margin:2px 0 0;accent-color:var(--color-accent);flex:none');
          return (
            <div className="dialog-backdrop" style={{ zIndex: 20 }}>
              <div className="dialog" style={sx('width:min(640px,100%);gap:20px;padding:36px 40px;border-radius:10px;max-height:86vh;overflow-y:auto;box-sizing:border-box',
                                                'width:min(640px,100%);gap:16px;padding:22px 20px;border-radius:14px;max-height:88vh;overflow-y:auto;box-sizing:border-box')}>
                <div className="dialog-title" style={sx('font-size:26px;line-height:1.35', 'font-size:20px;line-height:1.35')}>{CONSENT.title}</div>
                <p className="dialog-body" style={sx('font-size:18px;margin:0;opacity:1;line-height:1.55;color:var(--color-neutral-700)', 'font-size:14px;margin:0;opacity:1;line-height:1.55;color:var(--color-neutral-700)')}>{CONSENT.lead}</p>

                {/* 고지 표 — 수집 항목·목적·보유 기간·제공받는 자 */}
                <dl style={sx('margin:0;display:grid;grid-template-columns:auto 1fr;gap:10px 18px;padding:20px 22px;background:var(--color-surface);border-radius:8px;font-size:16px;line-height:1.5',
                              'margin:0;display:grid;grid-template-columns:auto 1fr;gap:8px 12px;padding:14px;background:var(--color-surface);border-radius:10px;font-size:13px;line-height:1.5')}>
                  {CONSENT.table.map(([k, v]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt style={css('color:var(--color-neutral-600);white-space:nowrap')}>{k}</dt>
                      <dd style={css('margin:0;color:var(--color-text)')}>{v}</dd>
                    </div>
                  ))}
                </dl>

                {/* 개별 동의 — 둘 다 필수 */}
                <div style={css('display:flex;flex-direction:column;gap:12px')}>
                  {CONSENT.items.map((item, i) => (
                    <label key={item.key} style={sx('display:flex;gap:12px;align-items:flex-start;font-size:17px;cursor:pointer;line-height:1.5',
                                                    'display:flex;gap:10px;align-items:flex-start;font-size:14px;cursor:pointer;line-height:1.5')}>
                      <input type="checkbox" checked={checks[i]} onChange={(e) => setChecks[i](e.target.checked)} style={cbStyle} />
                      <span><b style={css('color:var(--color-accent-700)')}>[필수]</b> {item.label}</span>
                    </label>
                  ))}
                </div>

                {/* 전체 동의 */}
                <label style={sx('display:flex;gap:12px;align-items:center;font-size:17px;font-weight:600;cursor:pointer;padding:14px 16px;border:1.5px solid var(--color-accent-400);border-radius:8px',
                                 'display:flex;gap:10px;align-items:center;font-size:15px;font-weight:600;cursor:pointer;padding:12px 14px;border:1.5px solid var(--color-accent-400);border-radius:10px')}>
                  <input
                    type="checkbox"
                    checked={allAgreed}
                    onChange={(e) => { setC1(e.target.checked); setC2(e.target.checked); }}
                    style={css('width:24px;height:24px;margin:0;accent-color:var(--color-accent);flex:none')}
                  />
                  <span>{CONSENT.agreeAll}</span>
                </label>

                <p style={sx('margin:0;font-size:15px;line-height:1.55;color:var(--color-neutral-600)', 'margin:0;font-size:12.5px;line-height:1.55;color:var(--color-neutral-600)')}>
                  {CONSENT.refusal}<br />{CONSENT.photoNote}
                </p>

                {submitErr && (
                  <p style={css(`margin:0;font-size:17px;line-height:1.5;color:${TONE_COLOR.danger}`)}>{submitErr}</p>
                )}

                <div className="dialog-actions" style={css('gap:14px')}>
                  <button className="btn btn-secondary" disabled={submitBusy} onClick={() => setConsentOpen(false)} style={sx('font-size:18px;padding:15px 22px;border-radius:8px', 'font-size:15px;padding:13px 16px;border-radius:9px')}>취소</button>
                  <button
                    className="btn btn-primary"
                    disabled={!allAgreed || submitBusy}
                    onClick={submitSupport}
                    style={sx('font-size:18px;padding:15px 26px;border-radius:8px', 'font-size:15px;padding:13px 18px;border-radius:9px')}
                  >
                    {submitBusy ? '접수하는 중…' : CONSENT.submit}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </main>

      <RainCanvas enabled height={isMobile ? 150 : 260} />
    </div>
  );
}
