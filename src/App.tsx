import { useRef, useState, useCallback, useEffect } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';
import { css } from './css';
import RainCanvas from './RainCanvas';
import { useIsMobile } from './useIsMobile';
import { lookupFlood, getCurrentPosition, coordsFromUrl, locationHelp, GeoError } from './sync/flood';
import { searchAddress, geocodeAddress } from './sync/address';
import FloodMap from './FloodMap';
import type { FloodResult } from './sync/flood';
import {
  SLOTS, QUESTIONS, FACTOR_NAMES, BASE_SCORE, BASE_FACTOR,
  SUPPORT_THRESHOLD, LEVEL_DESC, levelOf, recommendationsOf, EXAMPLES, CONTACT,
} from './content';
import type { QuestionKey } from './content';
import { analyzeHousePhotos, sendChatMessage, matchAnswerToOption } from './sync/openai';
import type { VLMAnalysisResult } from './sync/openai';

type Screen = 'landing' | 'upload' | 'chat' | 'result';

type Option = { label: string; pts: number };

type Message = {
  id?: string;
  role: 'bot' | 'user';
  text: string;
  img?: string | null;
  imgLabel?: string;
  options?: Option[];
  qIndex?: number;
  final?: boolean;
};

type Factor = { name: string; detail: string; pts: string };

type DynQuestion = {
  key: QuestionKey;
  photo: number;
  text: string;
  ack: string;
  options: [string, number][];
};

const CameraIcon = () => (
  <svg width="34" height="34" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path opacity=".25" d="M208 64h-28l-16-24H92L76 64H48a16 16 0 0 0-16 16v112a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V80a16 16 0 0 0-16-16Z"></path><path d="M208 56h-23.7L170.6 35.6A8 8 0 0 0 164 32H92a8 8 0 0 0-6.6 3.6L71.7 56H48a24 24 0 0 0-24 24v112a24 24 0 0 0 24 24h160a24 24 0 0 0 24-24V80a24 24 0 0 0-24-24Zm8 136a8 8 0 0 1-8 8H48a8 8 0 0 1-8-8V80a8 8 0 0 1 8-8h28a8 8 0 0 0 6.6-3.6L96.3 48h63.4l13.7 20.4A8 8 0 0 0 180 72h28a8 8 0 0 1 8 8Zm-88-100a44 44 0 1 0 44 44 44 44 0 0 0-44-44Zm0 72a28 28 0 1 1 28-28 28 28 0 0 1-28 28Z"></path></svg>
);

const DropMark = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 4 C20 4 8 18 8 25 a12 12 0 0 0 24 0 C32 18 20 4 20 4 Z" fill="var(--color-accent)" opacity=".9"></path></svg>
);

const STEPS = [
  { n: '1', title: '집 사진 3장 찍기', body: '현관 턱, 창문, 집 앞 골목. 안내대로 찍으면 됩니다.' },
  { n: '2', title: '몇 가지 질문에 답하기', body: '정확한 진단을 위해 챗봇과 대화하세요' },
  { n: '3', title: '위험 점수 확인', body: '과거의 기록과 자체 데이터베이스를 사용하여 진단합니다.' },
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
  const [scores, setScores] = useState<Partial<Record<QuestionKey, number>>>({});
  const [labels, setLabels] = useState<Partial<Record<QuestionKey, string>>>({});
  const [vlmResult, setVlmResult] = useState<VLMAnalysisResult | null>(null);
  const [dynQuestions, setDynQuestions] = useState<DynQuestion[]>([]);
  const [consentOpen, setConsentOpen] = useState(false);
  const [c1, setC1] = useState(false);
  const [c2, setC2] = useState(false);
  const [ticket, setTicket] = useState('');
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

    /* ── 문진 진행 중: 자유 텍스트를 보기에 매핑해 그대로 다음 단계로 전진 ── */
    if (p) {
      setWaiting(true);
      setWaitText('답변을 이해하는 중…');
      try {
        const labels = p.options.map((o) => o.label);
        const m = await matchAnswerToOption(text, p.text, labels);
        setWaiting(false);

        if (m.index >= 0) {
          const picked = p.options[m.index];
          push({ role: 'bot', text: `말씀을 「${picked.label}」(으)로 정리했어요.` });
          commitAnswer(p.i, picked.label, picked.pts, false);
          return;
        }

        /* 답변이 아니라 별도 질문 → 짧게 답하고 원래 질문을 다시 띄운다 */
        if (m.intent === 'question') {
          setWaiting(true);
          setWaitText('잠길까 도우미가 답변을 생성하는 중…');
          const reply = await sendChatMessage(messages, text, { address, scores, pendingQuestion: p.text });
          setWaiting(false);
          push({ role: 'bot', text: reply });
        }

        /* 어느 쪽이든 선택지를 다시 노출해 흐름이 끊기지 않게 한다 */
        push({
          id: 'q' + p.i,
          role: 'bot',
          text: m.intent === 'question'
            ? '이어서, 아까 여쭌 것도 알려주세요.'
            : '말씀을 보기 중 하나로 확실히 연결하지 못했어요. 아래에서 골라주시겠어요?',
          options: p.options,
          qIndex: p.i,
        });
      } catch (err) {
        console.error('[Answer Match Error]', err);
        setWaiting(false);
        push({
          id: 'q' + p.i,
          role: 'bot',
          text: '답변을 처리하지 못했어요. 아래에서 골라주세요.',
          options: p.options,
          qIndex: p.i,
        });
      }
      return;
    }

    /* ── 문진이 끝난 뒤: 일반 상담 대화 ── */
    setWaiting(true);
    setWaitText('잠길까 도우미가 답변을 생성하는 중…');
    try {
      const reply = await sendChatMessage(messages, text, { address, scores });
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
      runWait(['답변을 모아 점수를 계산하는 중…', '침수흔적도와 대조하는 중…'], () => {
        push({ role: 'bot', text: 'AI 정밀 분석과 확인이 모두 끝났습니다. 종합 침수 위험 점수를 확인해보세요.', final: true });
      });
      return;
    }
    const q = qs[i];
    /* 빈 배열이 와도 문진이 멈추지 않도록 마지막 방어선 */
    const src = q.options?.length ? q.options : (QUESTIONS[i]?.options ?? []);
    const opts: Option[] = src.map(([label, pts]) => ({ label, pts }));
    setPending({ i, text: q.text, options: opts });
    push({
      id: 'q' + i,
      role: 'bot',
      text: q.text,
      img: photosRef.current[q.photo],
      imgLabel: `올려주신 ${SLOTS[q.photo].slice(2)} 사진`,
      options: opts,
      qIndex: i,
    });
    /* push 도 매 렌더 재생성된다. 넣으면 askDyn 이 계속 바뀌어 문진이 리셋된다. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runWait]);

  /* 버튼 클릭 · 자유 텍스트 · 건너뛰기가 모두 통과하는 단일 진행 경로.
     echoUser=false 는 사용자 말풍선이 이미 찍힌 경우(자유 텍스트). */
  const commitAnswer = (i: number, label: string, pts: number, echoUser = true) => {
    const list = dynQuestions.length ? dynQuestions : (QUESTIONS as DynQuestion[]);
    const q = list[i] || QUESTIONS[i];
    setPending(null);
    setMessages((ms) => ms.map((m) => (m.id === 'q' + i ? { ...m, options: [] } : m)));
    setScores((s) => ({ ...s, [q.key]: pts }));
    setLabels((l) => ({ ...l, [q.key]: label }));
    if (echoUser) push({ role: 'user', text: label });

    if (i < list.length - 1) {
      runWait([q.ack || '고마워요. 다음 항목을 확인할게요.'], () => askDyn(list, i + 1));
    } else {
      runWait(['모든 답변을 결합하여 위험도를 산출하는 중…', '안양시 침수흔적도 매칭 중…'], () => {
        push({ role: 'bot', text: '확인이 모두 끝났습니다. 침수 위험도 진단 결과를 정리했습니다.', final: true });
      });
    }
  };

  const answer = (i: number, label: string, pts: number) => commitAnswer(i, label, pts, true);

  /* 안전망 — 지금 질문을 건너뛰고 다음으로 */
  const skipPending = () => {
    const p = pending;
    if (!p || waiting) return;
    commitAnswer(p.i, '잘 모르겠어요 (건너뜀)', 0, true);
  };

  const goHome = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    clearTimers();
    setScreen('landing'); setMessages([]); setWaiting(false);
    setScores({}); setLabels({}); setTicket(''); setConsentOpen(false); setC1(false); setC2(false);
    setVlmResult(null); setDynQuestions([]);
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
    setWaitText('GPT-4o-mini 멀티모달 Vision으로 사진 3장을 정밀 분석하는 중…');

    try {
      const result = await analyzeHousePhotos(photos, address);
      setVlmResult(result);
      setWaiting(false);

      // AI 사진 총평 출력
      push({
        role: 'bot',
        text: result.overview,
      });

      // VLM 기반 동적 질문 목록 구성
      const qs: DynQuestion[] = [
        {
          key: 'sill',
          photo: 0,
          text: result.factors.sill.customQuestion || QUESTIONS[0].text,
          ack: `[현관 문턱 AI 관찰: ${result.factors.sill.detail}] 확인되었습니다. 다음은 창문입니다.`,
          options: result.factors.sill.options?.length ? result.factors.sill.options : QUESTIONS[0].options,
        },
        {
          key: 'window',
          photo: 1,
          text: result.factors.window.customQuestion || QUESTIONS[1].text,
          ack: `[창문 위치 AI 관찰: ${result.factors.window.detail}] 좋습니다. 마지막으로 골목 침수 이력입니다.`,
          options: result.factors.window.options?.length ? result.factors.window.options : QUESTIONS[1].options,
        },
        {
          key: 'history',
          photo: 2,
          text: result.factors.history.customQuestion || QUESTIONS[2].text,
          ack: `[골목 지형 AI 관찰: ${result.factors.history.detail}]`,
          options: result.factors.history.options?.length ? result.factors.history.options : QUESTIONS[2].options,
        },
      ];

      setDynQuestions(qs);
      askDyn(qs, 0);
    } catch (err) {
      console.error('[AI Analysis Error]', err);
      setWaiting(false);
      const fallbackQs = QUESTIONS as DynQuestion[];
      setDynQuestions(fallbackQs);
      askDyn(fallbackQs, 0);
    }
  };

  /* 침수지도를 실제로 조회했으면 그 배점을, 아니면 예시 기본값을 쓴다 */
  const mapPts = flood ? flood.pts : BASE_SCORE;
  const score = mapPts + Object.values(scores).reduce((a: number, b: number) => a + b, 0);
  const level = levelOf(score);
  const mapFactor: Factor = flood
    ? {
        name: '도시침수지도 예상 침수심',
        detail: flood.covered
          ? `${flood.label}${flood.seg ? ` (등급 ${flood.seg})` : ''} · ${flood.source}`
          : flood.label,
        pts: '+' + flood.pts,
      }
    : BASE_FACTOR;
  const factors: Factor[] = [mapFactor];
  for (const k of ['sill', 'window', 'history'] as QuestionKey[]) {
    if (k in scores) {
      const aiDetail = vlmResult?.factors[k]?.detail;
      factors.push({
        name: FACTOR_NAMES[k],
        detail: aiDetail ? `${labels[k]} (${aiDetail})` : (labels[k] ?? ''),
        pts: '+' + scores[k],
      });
    }
  }

  const recs = recommendationsOf(scores);

  const onSendResultChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = resultInput.trim();
    if (!text || resultWaiting) return;
    setResultInput('');
    const history = resultChat;
    setResultChat((m) => [...m, { role: 'user', text }]);
    setResultWaiting(true);
    try {
      /* AI가 항목명과 점수 방향을 헷갈리지 않도록 사람이 읽는 문장으로 넘긴다.
         raw JSON(sill/window/history)을 그대로 주면 "차수판 20점" 같은 오답이 나온다. */
      const breakdown = factors.map((f) => `- ${f.name}: ${f.detail} → ${f.pts}점`).join('\n');
      const reply = await sendChatMessage(history, text, {
        address, scores,
        resultSummary: `총점 ${score}점 / 100 · 위험 등급 "${level}"
점수는 높을수록 위험이 크다는 뜻입니다(감점이 아닙니다). ${SUPPORT_THRESHOLD}점 이상이면 안양시 설치 지원 대상입니다.
점수 구성:
${breakdown}`,
      });
      setResultChat((m) => [...m, { role: 'bot', text: reply }]);
    } catch {
      setResultChat((m) => [...m, { role: 'bot', text: '답변을 불러오는 중 오류가 발생했습니다.' }]);
    } finally {
      setResultWaiting(false);
    }
  };
  const needsSupport = score >= SUPPORT_THRESHOLD;

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
            {flood.inMap ? `침수 예상 구역입니다 (+${flood.pts}점)` : flood.covered ? '침수 예상 구역이 아닙니다 (+0점)' : '판정 범위 밖입니다'}
          </strong>
          <span style={sx('font-size:16px;color:var(--color-neutral-700)', 'font-size:13px;color:var(--color-neutral-700)')}>{flood.label}</span>
          {flood.freq30 && flood.freq50 && (
            <span style={sx('font-size:15px;color:var(--color-neutral-700)', 'font-size:12.5px;color:var(--color-neutral-700)')}>
              30년 빈도 {flood.freq30.inMap ? `침수 (${flood.freq30.seg})` : '해당 없음'} · 50년 빈도 {flood.freq50.inMap ? `침수 (${flood.freq50.seg})` : '해당 없음'}
              {!flood.freq30.inMap && flood.freq50.inMap ? ' — 더 큰 비에는 잠길 수 있어요' : ''}
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
              <p style={css('margin:0;font-size:18px;color:var(--color-neutral-700);text-wrap:pretty')}>밝을 때 흔들리지 않게 찍어 주세요. 사진은 진단에만 쓰이고, 동의 없이는 어디에도 전달되지 않습니다.</p>
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
                        {!!m.options?.length && (
                          <div style={css('display:flex;flex-direction:column;gap:10px')}>
                            {m.options.map((opt) => (
                              <button
                                key={opt.label}
                                className="btn btn-secondary"
                                onClick={() => answer(m.qIndex as number, opt.label, opt.pts)}
                                style={sx('font-size:21px;padding:16px 22px;min-height:64px;justify-content:flex-start;border:1.5px solid var(--color-accent-400);border-radius:8px;background:var(--color-bg);font-weight:400', 'font-size:16px;padding:13px 16px;min-height:54px;justify-content:flex-start;border:1.5px solid var(--color-accent-400);border-radius:10px;background:var(--color-bg);font-weight:400;text-align:left')}
                              >
                                {opt.label}
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
                {pending ? `${pending.i + 1} / ${dynQuestions.length || QUESTIONS.length} 번째 질문` : '문진 완료'}
              </span>
            </div>
          </section>
        )}

        {screen === 'result' && (
          <section style={sx('padding-top:16px;display:flex;flex-direction:column;gap:56px', 'padding-top:0;display:flex;flex-direction:column;gap:30px')}>
            {isMobile && (
              /* 스크롤해도 점수가 상단에 붙어 있다 */
              <div style={css('position:sticky;top:0;z-index:5;background:var(--color-bg);padding:10px 0 10px;border-bottom:1px solid var(--color-neutral-200);display:flex;justify-content:space-between;align-items:baseline;gap:12px')}>
                <span style={css('font-size:40px;line-height:1;font-weight:600;letter-spacing:-0.03em')}>{score}<small style={css('font-size:13px;color:var(--color-neutral-600);font-weight:400;margin-left:4px')}>/ 100</small></span>
                <span style={css(`font-size:18px;font-weight:600;letter-spacing:-0.01em;color:${needsSupport ? 'var(--color-accent-2-700)' : 'var(--color-accent-700)'}`)}>침수 위험 {level}</span>
              </div>
            )}
            <div style={sx('display:grid;grid-template-columns:auto 1fr;gap:56px;align-items:end', 'display:flex;flex-direction:column;gap:12px')}>
              {!isMobile && (
              <div style={css('display:flex;flex-direction:column;gap:10px')}>
                <p style={css('color:var(--color-accent-700);font-size:19px;margin:0')}>3단계 · 진단 결과</p>
                <div style={css('display:flex;align-items:baseline;gap:10px')}>
                  <span style={css('font-size:168px;line-height:.9;font-weight:600;letter-spacing:-0.04em')}>{score}</span>
                  <span style={css('font-size:32px;color:var(--color-neutral-600)')}>/ 100</span>
                </div>
              </div>
              )}
              <div style={sx('display:flex;flex-direction:column;gap:16px;padding-bottom:14px', 'display:flex;flex-direction:column;gap:10px')}>
                {isMobile && <p style={css('color:var(--color-accent-700);font-size:15px;margin:0')}>3단계 · 진단 결과</p>}
                {!isMobile && <h2 style={css(`font-size:54px;margin:0;letter-spacing:-0.02em;color:${needsSupport ? 'var(--color-accent-2-700)' : 'var(--color-accent-700)'}`)}>침수 위험 {level}</h2>}
                <p style={sx('font-size:23px;line-height:1.5;color:var(--color-neutral-700);margin:0;max-width:560px;text-wrap:pretty', 'font-size:16px;line-height:1.5;color:var(--color-neutral-700);margin:0;text-wrap:pretty')}>{LEVEL_DESC[level]}</p>
                <div style={css('position:relative;height:12px;border-radius:6px;background:var(--color-neutral-200);max-width:560px;margin-top:8px')}>
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 6, background: 'var(--color-accent)', width: `${score}%` }} />
                  <span style={css('position:absolute;left:50%;top:-6px;width:2px;height:24px;background:var(--color-neutral-500)')} />
                </div>
                <p style={sx('font-size:17px;color:var(--color-neutral-600);margin:0', 'font-size:13px;color:var(--color-neutral-600);margin:0')}>가운데 선({SUPPORT_THRESHOLD}점)이 넘으면 안양시 설치 지원 대상입니다.</p>
              </div>
            </div>

            {floodPos && flood && flood.covered && (
              /* 결과 화면 — 같은 지도에 침수 레이어가 차오르고 점수가 새겨진다 */
              <div style={css('display:flex;flex-direction:column;gap:10px')}>
                <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>내 위치의 침수 예상 구역</h3>
                <div style={css('border:1px solid var(--color-neutral-200);border-radius:12px;overflow:hidden')}>
                  <FloodMap
                    lat={floodPos.lat}
                    lon={floodPos.lon}
                    accuracy={floodPos.acc}
                    shapes={flood.shapes?.freq50 ?? flood.shapes?.freq30}
                    badge={{ seg: flood.seg, pts: flood.pts }}
                    overlay
                    zoom={16}
                    height={isMobile ? 210 : 300}
                  />
                </div>
                <p style={sx('font-size:16px;color:var(--color-neutral-700);margin:0', 'font-size:13px;color:var(--color-neutral-700);margin:0')}>
                  진할수록 예상 침수심이 깊은 구간입니다. {flood.freq30 && flood.freq50 && !flood.freq30.inMap && flood.freq50.inMap
                    ? '30년 빈도에는 안전하지만 50년 빈도 강우에는 침수 예상 구역에 들어갑니다.'
                    : '50년 빈도 강우 기준으로 표시했습니다.'}
                </p>
              </div>
            )}

            <div style={sx('display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:start', 'display:flex;flex-direction:column;gap:28px')}>
              <div style={css('display:flex;flex-direction:column;gap:18px')}>
                <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>왜 이런 점수가 나왔나요</h3>
                <ul style={css('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:18px')}>
                  {factors.map((f) => (
                    <li key={f.name} style={css('display:grid;grid-template-columns:1fr auto;gap:16px;align-items:baseline')}>
                      <div>
                        <strong style={sx('font-size:21px;display:block', 'font-size:16px;display:block')}>{f.name}</strong>
                        <span style={sx('font-size:18px;color:var(--color-neutral-700)', 'font-size:14px;color:var(--color-neutral-700)')}>{f.detail}</span>
                      </div>
                      <span style={sx('font-size:26px;font-weight:600;color:var(--color-accent-700)', 'font-size:20px;font-weight:600;color:var(--color-accent-700)')}>{f.pts}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div style={css('display:flex;flex-direction:column;gap:18px')}>
                <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>지금 할 수 있는 대비</h3>
                <ul style={css('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:18px')}>
                  {recs.map((r) => (
                    <li key={r.title}>
                      <strong style={sx('font-size:21px;display:block', 'font-size:16px;display:block')}>{r.title}</strong>
                      <span style={sx('font-size:18px;color:var(--color-neutral-700);text-wrap:pretty', 'font-size:14px;color:var(--color-neutral-700);text-wrap:pretty')}>{r.body}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {needsSupport && (
              <div style={sx('background:var(--color-surface);padding:38px 42px;border-radius:8px;display:grid;grid-template-columns:1fr auto;gap:36px;align-items:center', 'background:var(--color-surface);padding:20px 18px;border-radius:12px;display:flex;flex-direction:column;gap:16px')}>
                <div style={css('display:flex;flex-direction:column;gap:12px')}>
                  <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>지원이 필요한 수준이에요</h3>
                  <p style={sx('font-size:20px;margin:0;color:var(--color-neutral-700);text-wrap:pretty', 'font-size:14px;margin:0;color:var(--color-neutral-700);text-wrap:pretty')}>안양시 담당 부서에 직접 연락하거나, 버튼 하나로 바로 접수할 수 있어요. 접수하면 담당 공무원이 우선순위를 검토해 차수판·물막이판 설치를 안내합니다.</p>
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
              <p style={sx('font-size:20px;color:var(--color-neutral-700);margin:0;text-wrap:pretty', 'font-size:15px;color:var(--color-neutral-700);margin:0;text-wrap:pretty')}>지금은 설치 지원 기준({SUPPORT_THRESHOLD}점)보다 낮아요. 큰 비 예보가 있으면 다시 확인해 주세요.</p>
            )}

            {/* 결과에 대한 후속 대화 */}
            <div style={css('display:flex;flex-direction:column;gap:22px;max-width:780px')}>
              <div style={css('display:flex;flex-direction:column;gap:6px')}>
                <h3 style={sx('font-size:28px;margin:0', 'font-size:20px;margin:0')}>결과에 대해 더 물어보기</h3>
                <p style={sx('font-size:18px;color:var(--color-neutral-700);margin:0', 'font-size:14px;color:var(--color-neutral-700);margin:0')}>점수 근거, 대비책, 지원 사업 등 궁금한 것을 잠길까 도우미에게 물어보세요.</p>
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
                  placeholder="예) 왜 창문 점수가 높게 나왔나요? 물막이판은 어디서 사나요?"
                  disabled={resultWaiting}
                  style={sx('flex:1;border:none;background:transparent;font-size:19px;color:var(--color-text);outline:none;font-family:inherit;min-width:0', 'flex:1;border:none;background:transparent;font-size:16px;color:var(--color-text);outline:none;font-family:inherit;min-width:0')}
                />
                <button type="submit" className="btn btn-primary" disabled={resultWaiting || !resultInput.trim()} style={sx('font-size:18px;padding:12px 24px;border-radius:8px;font-weight:600', 'font-size:15px;padding:10px 16px;border-radius:9px;font-weight:600')}>전송</button>
              </form>
            </div>

            <a href="#" onClick={goHome} style={css('font-size:20px;align-self:flex-start')}>처음으로 돌아가기</a>
          </section>
        )}

        {consentOpen && (
          <div className="dialog-backdrop" style={{ zIndex: 20 }}>
            <div className="dialog" style={sx('width:min(600px,100%);gap:26px;padding:40px;border-radius:10px', 'width:min(600px,100%);gap:18px;padding:22px 20px;border-radius:14px;box-sizing:border-box')}>
              <div className="dialog-title" style={css('font-size:30px;line-height:1.3')}>접수 전에 동의가 필요해요</div>
              <p className="dialog-body" style={css('font-size:19px;margin:0;opacity:1;color:var(--color-neutral-700)')}>두 가지에 동의하시면 진단 결과가 안양시로 전달되고, 담당 공무원이 설치 지원을 검토합니다.</p>
              <label style={css('display:flex;gap:14px;align-items:flex-start;font-size:20px;cursor:pointer;line-height:1.5')}>
                <input type="checkbox" checked={c1} onChange={(e) => setC1(e.target.checked)} style={css('width:26px;height:26px;margin:4px 0 0;accent-color:var(--color-accent);flex:none')} />
                <span>주소·사진·진단 결과를 안양시에 제공하는 데 동의합니다.</span>
              </label>
              <label style={css('display:flex;gap:14px;align-items:flex-start;font-size:20px;cursor:pointer;line-height:1.5')}>
                <input type="checkbox" checked={c2} onChange={(e) => setC2(e.target.checked)} style={css('width:26px;height:26px;margin:4px 0 0;accent-color:var(--color-accent);flex:none')} />
                <span>담당 공무원이 설치 지원 우선순위 판단에 이 정보를 사용하는 데 동의합니다.</span>
              </label>
              <div className="dialog-actions" style={css('gap:14px')}>
                <button className="btn btn-secondary" onClick={() => setConsentOpen(false)} style={css('font-size:20px;padding:16px 24px;border-radius:8px')}>취소</button>
                <button
                  className="btn btn-primary"
                  disabled={!(c1 && c2)}
                  onClick={() => { setConsentOpen(false); setTicket('AY-' + String(Math.floor(100000 + Math.random() * 900000))); }}
                  style={css('font-size:20px;padding:16px 28px;border-radius:8px')}
                >
                  동의하고 접수하기
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <RainCanvas enabled height={isMobile ? 150 : 260} />
    </div>
  );
}
