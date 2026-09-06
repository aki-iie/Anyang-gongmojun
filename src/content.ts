/* 챗봇 문답 정의 — 여기만 고치면 질문·선택지·배점이 바뀝니다.
   photo: 질문할 때 다시 보여줄 사진 인덱스 (0 현관 턱 / 1 창문 / 2 골목)
   options: [보기 문구, 위험 점수] */
export const SLOTS = ['① 현관 턱', '② 창문', '③ 집 앞 골목'];

export const WAIT = [
  '보내주신 사진을 살펴보는 중…',
  '현관 턱 높이를 정확히 계량하는 중…',
  '안양시 도시침수지도를 펼치는 중…',
  '하늘에게 물어보는 중…',
];

export const QUESTIONS: { key: QuestionKey; photo: number; text: string; ack: string; options: [string, number][] }[] = [
  {
    key: 'sill',
    photo: 0,
    text: '현관 앞에 턱이 보이네요. 사진만으로는 높이가 애매해서 여쭤요. 신용카드를 세운 높이(약 8.5cm)와 비교하면 어느 정도인가요?',
    ack: '고마워요. 다음은 창문을 볼게요.',
    options: [
      ['카드보다 낮아요', 30],
      ['카드 1장 정도예요', 20],
      ['카드 2장 정도예요 (약 17cm)', 10],
      ['그보다 훨씬 높아요', 0],
    ],
  },
  {
    key: 'window',
    photo: 1,
    text: '창문 아래쪽이 바깥 땅바닥에서 얼마나 떨어져 있나요?',
    ack: '좋아요. 마지막으로 골목 이야기예요.',
    options: [
      ['거의 땅에 붙어 있어요', 20],
      ['카드 2장 정도예요 (약 17cm)', 12],
      ['무릎 높이쯤이에요', 5],
      ['그보다 높아요', 0],
    ],
  },
  {
    key: 'history',
    photo: 2,
    text: '2022년 8월 집중호우 때, 이 골목에 물이 찼던 기억이 있나요?',
    ack: '',
    options: [
      ['네, 물이 찼어요', 15],
      ['아니요, 괜찮았어요', 0],
      ['잘 모르겠어요', 5],
    ],
  },
];

export const FACTOR_NAMES: Record<QuestionKey, string> = {
  sill: '현관 턱 높이',
  window: '창문 아래쪽 높이',
  history: '골목 침수 이력 (2022년 8월)',
};

/* 기본 30점 = 도시침수지도 예상 침수심(예시값). 실제 조회로 대체하세요. */
export const BASE_SCORE = 30;
export const BASE_FACTOR = { name: '도시침수지도 예상 침수심', detail: '50년 빈도 강우 시 약 0.3m (예시 데이터)', pts: '+30' };

/* 지원 접수 대상 기준 점수 */
export const SUPPORT_THRESHOLD = 50;

export const LEVEL_DESC: Record<Level, string> = {
  '매우 높음': '집중호우 때 현관과 창문으로 물이 들어올 가능성이 큽니다. 바로 대비가 필요해요.',
  '높음': '비가 많이 오면 물이 들어올 수 있는 구조예요. 안양시 설치 지원 대상에 해당합니다.',
  '주의': '큰 비에는 위험할 수 있어요. 간단한 대비를 권해요.',
  '낮음': '지금 구조로는 큰 걱정은 없어요. 비 예보가 있을 때 다시 확인해 주세요.',
};

export type QuestionKey = 'sill' | 'window' | 'history';

export type Level = '매우 높음' | '높음' | '주의' | '낮음';

export function levelOf(score: number): Level {
  return score >= 70 ? '매우 높음' : score >= 50 ? '높음' : score >= 30 ? '주의' : '낮음';
}

export function recommendationsOf(scores: Partial<Record<QuestionKey, number>>) {
  const recs: { title: string; body: string }[] = [];
  if ((scores.sill ?? 0) >= 20) recs.push({ title: '현관 물막이판(탈부착형) 설치', body: '현관 턱이 낮아 가장 먼저 필요한 대비예요. 임대인 동의 없이도 설치할 수 있는 탈부착형이 있어요.' });
  if ((scores.window ?? 0) >= 12) recs.push({ title: '창문 차수막 설치', body: '안양시가 설치를 지원하는 항목이에요. 접수하면 우선순위에 따라 무료로 설치됩니다.' });
  recs.push({ title: '비 예보 때 대피 경로 확인', body: '현관이 막히면 창문으로 나갈 수 있는지, 물이 차기 전 옮길 물건이 무엇인지 미리 정해 두세요.' });
  return recs;
}

/* 촬영 예시 사진 — public/ 폴더의 파일. 교체하려면 같은 이름으로 덮어쓰세요. */
export const EXAMPLES = [
  { src: '/ex-sill.webp', title: '① 현관 턱(문턱)', body: '정면에서, 신용카드나 손을 턱 옆에 대고 찍어 주세요.' },
  { src: '/ex-window.webp', title: '② 창문', body: '바깥에서, 땅바닥과 창문 아래쪽이 한 장에 나오게 찍어 주세요.' },
  { src: '/ex-alley.webp', title: '③ 집 앞 골목', body: '현관에서 길 쪽을 보고, 경사와 배수구가 보이게 찍어 주세요.' },
];

/* 담당 부서 연락처 — 실제 번호로 교체하세요. */
export const CONTACT = { phone: '031-8045-0000', dept: '안양시청 재난안전과 · 예시 번호' };
