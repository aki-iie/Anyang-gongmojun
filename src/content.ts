/* 화면 문구와 사진 설정.
   질문·선택지는 여기 없다 — 12문항의 단일 원천은 functions/src/prompt.ts 의 SLOT_SPEC 이고,
   판정 규칙은 src/utils/diagnose.ts 에 있다 (둘 다 차동현 담당). */
import type { Slots } from './utils/diagnose';

/* 사진 세 장의 이름 (0 현관 턱 / 1 창문 / 2 골목) */
export const SLOTS = ['① 현관 턱', '② 창문', '③ 집 앞 골목'];

/* 슬롯마다 질문 옆에 다시 보여줄 사진. null 이면 사진 없이 묻는다.
   여기 사진이 지정된 슬롯만 AI 사진 판독 대상이 된다. */
export const SLOT_PHOTO: Record<keyof Slots, 0 | 1 | 2 | null> = {
  entrance_sill: 0,
  stair_count: null,
  water_panel: 0,
  window_base: 1,
  window_barrier: 1,
  backflow_valve: null,   // 집 안 배수구라 바깥 사진 세 장에는 안 찍힌다
  rainy_symptom: null,
  gurgling: null,
  floor_backup: null,
  road_slope: 2,
  drain_status: 2,
  canopy: 0,
};

/* 확인 질문·결과 요약에 쓰는 슬롯의 짧은 이름 */
export const SLOT_NAME: Record<keyof Slots, string> = {
  entrance_sill: '현관 턱 높이',
  stair_count: '현관 계단',
  water_panel: '현관 물막이판',
  window_base: '창문 아래쪽 위치',
  window_barrier: '창문 차수막',
  backflow_valve: '역류방지밸브',
  rainy_symptom: '비 올 때 배수·냄새',
  gurgling: '배수 이상음',
  floor_backup: '바닥 배수구 역류',
  road_slope: '골목 경사',
  drain_status: '빗물받이',
  canopy: '현관 차양',
};

export const WAIT = [
  '보내주신 사진을 살펴보는 중…',
  '현관 턱 높이를 정확히 계량하는 중…',
  '안양시 도시침수지도를 펼치는 중…',
  '하늘에게 물어보는 중…',
];

/* 결과 화면의 판정 상태별 색 톤 — danger 는 붉은 강조, ok 는 차분한 톤 */
export const STATUS_TONE: Record<string, 'danger' | 'warn' | 'ok' | 'unknown'> = {
  유입가능: 'danger',
  방어가능: 'ok',
  매우미흡: 'danger',
  미흡: 'warn',
  양호: 'ok',
  확인필요: 'unknown',
};

/* 촬영 예시 사진 — public/ 폴더의 파일. 교체하려면 같은 이름으로 덮어쓰세요. */
export const EXAMPLES = [
  { src: '/ex-sill.webp', title: '① 현관 턱(문턱)', body: '정면에서, 신용카드나 손을 턱 옆에 대고 찍어 주세요.' },
  { src: '/ex-window.webp', title: '② 창문', body: '바깥에서, 땅바닥과 창문 아래쪽이 한 장에 나오게 찍어 주세요.' },
  { src: '/ex-alley.webp', title: '③ 집 앞 골목', body: '현관에서 길 쪽을 보고, 경사와 배수구가 보이게 찍어 주세요.' },
];

/* ────────────────────────────────────────────────────────────
   개인정보 동의 — 접수(지원 신청) 단계에서만 받는다.
   개인정보보호법이 요구하는 네 가지(수집 항목 / 목적 / 보유 기간 / 거부 권리와
   불이익)를 모두 화면에 적는다. 체크박스 문구만 두고 표를 생략하면 고지 의무를
   채우지 못한다.
   ⚠ RETENTION 기간은 팀에서 담당 부서와 확인해 확정할 것 — 지금은 잠정값이다.
   ──────────────────────────────────────────────────────────── */
export const CONSENT = {
  title: '개인정보 수집·이용 및 제3자 제공 동의',
  lead: '설치 지원 접수를 위해 아래 내용에 동의가 필요합니다. 이름과 연락처는 수집하지 않습니다.',

  /* 고지 표 — [항목, 내용] */
  table: [
    ['수집 항목', '주소(도로명·상세), 위치 좌표, 진단 문답 답변, 진단 결과'],
    ['수집·이용 목적', '반지하 침수 피해 예방 설치 지원사업 대상 검토 및 안내'],
    ['보유·이용 기간', '접수일로부터 1년. 기간이 지나면 지체 없이 파기합니다'],
    ['제공받는 자', '안양시청 재난안전과'],
    ['제공 목적', '설치 지원 우선순위 검토 및 현장 확인'],
  ] as [string, string][],

  items: [
    { key: 'provide' as const, label: '개인정보 수집·이용에 동의합니다.' },
    { key: 'priority' as const, label: '안양시청 재난안전과에 제3자 제공하는 데 동의합니다.' },
  ],

  refusal: '동의를 거부하실 수 있습니다. 이 경우 설치 지원 접수만 제한되고, 진단 결과를 보시는 데에는 아무 영향이 없습니다.',
  photoNote: '올려주신 사진은 진단에만 쓰이고 서버에 저장되지 않습니다.',
  agreeAll: '위 내용을 확인했으며 모두 동의합니다',
  submit: '동의하고 접수하기',
};

/* 통계 기록 사전 고지 — 동의 대상이 아니라 "알리는" 문구다.
   주소·사진 없이 대략적인 위치(100m 격자)와 판정 결과만 남기기 때문에 동의를 받지
   않지만, 수집 사실 자체는 진단을 시작하기 전에 알려야 한다. */
export const STATS_NOTE = '진단 결과는 주소와 사진 없이, 대략적인 위치와 함께 통계로만 기록돼 지역별 침수 위험 분석에 쓰입니다.';

/* 담당 부서 연락처 — 실제 번호로 교체하세요. */
export const CONTACT = { phone: '031-8045-2222', dept: '안양시청 재난안전과 · 예시 번호' };
