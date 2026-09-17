/* 지원 접수 저장 — 진단 결과를 Firestore(diagnoses)에 기록한다.
   엔드포인트 등록은 index.js 가 한다 (CLAUDE.md 경계 규칙: 순수 로직과 등록을 분리).

   저장 기준 — 세 가지를 모두 만족할 때만 기록한다. 클라이언트 값을 그대로 믿지 않고
   서버에서 다시 검사한다(위조 요청으로 공무원 대시보드에 쓰레기가 쌓이는 것을 막는다).
     1) 위험 판정이 실제로 났을 것
        경로 A 지표유입 '유입가능'  또는  경로 B 역류 '미흡'/'매우미흡'
        (App.tsx 의 needsSupport 와 동일한 조건. 임의 점수 기준을 새로 만들지 않는다)
     2) 동의 두 건 모두 체크 (제공 동의 + 우선순위 판단 사용 동의)
     3) 좌표가 안양시 부근일 것

   사진은 받지도 저장하지도 않는다. 슬롯 답변과 판정 결과 텍스트만 남긴다. */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { dongOf } = require('./dong');

/* 안양시 대략 경위도 범위 — 엉뚱한 좌표를 걸러내는 최소 방어선.
   정밀 판정은 flood.js 의 inCoverage() 가 이미 한다. */
const BBOX = { minLat: 37.30, maxLat: 37.50, minLon: 126.85, maxLon: 127.05 };

/* 12슬롯 — 단일 원천은 functions/src/prompt.ts 의 SLOT_SPEC(차동현 담당)이다.
   여기서는 "모르는 키를 걸러내는" 용도로만 쓴다. 값 자체는 문자열 길이만 본다 —
   명세가 바뀌었을 때 저장이 조용히 막히는 쪽이 더 위험하기 때문. */
const SLOT_IDS = [
  'entrance_sill', 'stair_count', 'water_panel', 'window_base',
  'window_barrier', 'backflow_valve', 'rainy_symptom', 'gurgling',
  'floor_backup', 'road_slope', 'drain_status', 'canopy',
];

const SURFACE_STATUS = new Set(['유입가능', '방어가능', '확인필요']);
const BACKFLOW_STATUS = new Set(['양호', '미흡', '매우미흡', '확인필요']);

class BadRequest extends Error {}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const strList = (v, max, cap) =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, cap).map((x) => x.slice(0, max)) : [];

/* 도로명주소에서 구(區)만 뽑는다. 행정동은 지오코더 응답에 없어 지금은 채우지 않는다.
   대시보드 1차 필터는 만안구/동안구로 충분하고, 정밀 집계는 좌표로 할 수 있다. */
function districtOf(address) {
  if (!address) return null;
  const m = String(address).match(/(만안구|동안구)/);
  return m ? m[1] : null;
}

/* ────────────────────────────────────────────────────────────
   레벨 — 두 경로 판정을 하나의 표시용 라벨로 합친다.
   이건 새로운 판정이 아니라 **분류용 파생값**이다. 엔진(diagnose.ts/py)은 일부러
   단일 점수를 만들지 않으므로, 여기서 만든 라벨을 판정 근거로 쓰면 안 된다.
   '확인필요'를 '안전'에 섞지 않는 것이 핵심 — 모르는 것을 안전으로 분류하면
   "저기는 괜찮다더라"가 되어 버린다.
   ──────────────────────────────────────────────────────────── */
function levelOf(surfaceStatus, backflowStatus) {
  if (surfaceStatus === '유입가능' || backflowStatus === '매우미흡') return '위험';
  if (backflowStatus === '미흡') return '주의';
  if (surfaceStatus === '확인필요' || backflowStatus === '확인필요') return '확인필요';
  return '안전';
}

/* 100m 격자 — scripts/DS2_spatial_grid_analysis.ipynb 의 CELL_M = 100 과 같은 크기다.
   통계 컬렉션에는 정확한 좌표 대신 이 격자만 남긴다(동의 없이 받은 기록이므로).
   더 큰 여유를 두고 싶으면 CELL_M 만 키우면 된다. */
const CELL_M = 100;

function gridOf(lat, lon) {
  if (lat === null || lon === null) return null;
  const dLat = CELL_M / 111000;
  const dLon = CELL_M / (111320 * Math.cos((lat * Math.PI) / 180));
  const iy = Math.floor(lat / dLat);
  const ix = Math.floor(lon / dLon);
  return {
    id: `${CELL_M}m_${iy}_${ix}`,
    /* 셀 중심 좌표 — 지도에 점으로 찍을 수 있게. 원좌표는 저장하지 않는다. */
    lat: Math.round((iy + 0.5) * dLat * 1e6) / 1e6,
    lon: Math.round((ix + 0.5) * dLon * 1e6) / 1e6,
    cellM: CELL_M,
  };
}

/** 접수번호 — 화면 표기와 같은 AY-###### 형식 */
function makeTicket() {
  return 'AY-' + String(Math.floor(100000 + Math.random() * 900000));
}

/** 요청 body 를 검사하고 Firestore 에 넣을 문서를 만든다. 문제가 있으면 BadRequest. */
function validateAndBuild(body) {
  const b = body || {};
  const loc = b.location || {};
  const dx = b.diagnosis || {};
  const surface = dx.surface || {};
  const backflow = dx.backflow || {};
  const consent = b.consent || {};

  /* 1) 동의 */
  if (consent.provide !== true || consent.priority !== true) {
    throw new BadRequest('두 가지 동의가 모두 필요합니다');
  }

  /* 2) 위험 판정 — 저장 대상인지 */
  if (!SURFACE_STATUS.has(surface.status)) throw new BadRequest('surface.status 값이 올바르지 않습니다');
  if (!BACKFLOW_STATUS.has(backflow.status)) throw new BadRequest('backflow.status 값이 올바르지 않습니다');
  const atRisk = surface.status === '유입가능'
    || backflow.status === '미흡' || backflow.status === '매우미흡';
  if (!atRisk) throw new BadRequest('지원이 필요한 판정이 아니어서 접수 대상이 아닙니다');

  /* 3) 좌표 */
  const lat = num(loc.lat), lon = num(loc.lon);
  if (lat === null || lon === null) throw new BadRequest('좌표가 없습니다');
  if (lat < BBOX.minLat || lat > BBOX.maxLat || lon < BBOX.minLon || lon > BBOX.maxLon) {
    throw new BadRequest('안양시 범위를 벗어난 좌표입니다');
  }

  const address = str(loc.address, 200);
  /* 행정동은 좌표에서 서버가 직접 판정한다 — 클라이언트가 보낸 값은 쓰지 않는다.
     주소가 없는 GPS 경로에서도 채워진다. */
  const dong = dongOf(lon, lat);

  /* 슬롯 — 아는 키만, 값은 짧은 문자열만 */
  const slots = {};
  const raw = b.slots || {};
  for (const id of SLOT_IDS) {
    const v = str(raw[id], 20);
    if (v) slots[id] = v;
  }

  const flood = b.flood || {};

  return {
    location: {
      lat, lon,
      address,                          // 도로명주소 (지오코더가 정제한 값)
      detail: str(loc.detail, 100),     // 상세주소 — 지하 1층 등. 설치 지원에 필요
      district: (dong && dong.gu) || districtOf(address),   // 경계 판정 우선, 없으면 주소 파싱
      dong: dong && dong.name,          // 행정동 (법정동 아님 — dong.js 주석 참고)
      dongCode: dong && dong.code,      // 행안부 10자리 행정기관코드
    },

    /* 판정에 들어간 침수심이 어디서 나왔는지 — 나중에 근거를 되짚을 수 있어야 한다 */
    flood: {
      covered: flood.covered === true,
      inMap: flood.inMap === true,
      seg: str(flood.seg, 20),
      predCm: num(flood.predCm),        // 채널 A 도시침수지도 예측
      traceCm: num(flood.traceCm),      // 채널 B 침수흔적도 실측
      depthCm: num(flood.depthCm),      // 판정용 = max(예측, 실측)
      basis: str(flood.basis, 20),
    },

    slots,

    diagnosis: {
      surface: {
        status: surface.status,
        reason: str(surface.reason, 300),
        effectiveDefenseCm: num(surface.effectiveDefenseCm),
        weakestPoint: str(surface.weakestPoint, 10),
        inflowCm: num(surface.inflowCm),
        needBarrierCm: num(surface.needBarrierCm),
      },
      backflow: {
        status: backflow.status,
        signals: strList(backflow.signals, 200, 10),
        signalCount: num(backflow.signalCount) ?? 0,
        experienced: backflow.experienced === true,
      },
      warnings: strList(dx.warnings, 200, 12),
      /* 조치 안내는 항목명만 — 설명 문구는 코드에 있으므로 중복 저장하지 않는다 */
      actions: strList((dx.actions || []).map((a) => (a && a.item) || ''), 60, 8).filter(Boolean),
      quality: {
        unknownCount: num((dx.quality || {}).unknownCount) ?? 0,
        totalSlots: num((dx.quality || {}).totalSlots) ?? SLOT_IDS.length,
        reliable: (dx.quality || {}).reliable === true,
      },
    },

    /* 서버가 두 경로 판정에서 파생한다. 클라이언트가 보낸 값은 받지 않는다. */
    level: levelOf(surface.status, backflow.status),

    consent: { provide: true, priority: true },
    status: '미확인',                   // 공무원 워크플로우: 미확인 → 확인중 → 지원연계완료
    ticket: makeTicket(),
  };
}

/** 검증 후 저장하고 접수번호를 돌려준다. */
async function saveDiagnosis(body) {
  const doc = validateAndBuild(body);
  doc.createdAt = FieldValue.serverTimestamp();
  const ref = await getFirestore().collection('diagnoses').add(doc);
  return { ticket: doc.ticket, id: ref.id };
}


/* ────────────────────────────────────────────────────────────
   통계 기록 — 진단을 끝낸 모든 건을 익명으로 남긴다.
   접수(diagnoses)와 목적이 다르므로 컬렉션을 나눈다.
     diagnoses : 동의를 받은 접수 건. 도로명주소·상세주소까지 있다.
     stats     : 동의 없이 남기는 통계. 주소도, 정확한 좌표도 없다.
   "안전하게 나온 집"의 분포가 있어야 판정이 실제로 갈라지는지 보일 수 있다.
   개인을 식별할 수 있는 값은 어떤 것도 넣지 않는다.
   ──────────────────────────────────────────────────────────── */
function buildStats(body) {
  const b = body || {};
  const dx = b.diagnosis || {};
  const surface = dx.surface || {};
  const backflow = dx.backflow || {};
  const flood = b.flood || {};

  if (!SURFACE_STATUS.has(surface.status)) throw new BadRequest('surface.status 값이 올바르지 않습니다');
  if (!BACKFLOW_STATUS.has(backflow.status)) throw new BadRequest('backflow.status 값이 올바르지 않습니다');

  /* 좌표는 격자로 바꾼 뒤 버린다. 범위 밖이면 위치 없이 집계만 남긴다. */
  const lat = num((b.location || {}).lat);
  const lon = num((b.location || {}).lon);
  const inBox = lat !== null && lon !== null
    && lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;
  const statsDong = inBox ? dongOf(lon, lat) : null;

  const slots = {};
  const raw = b.slots || {};
  for (const id of SLOT_IDS) {
    const v = str(raw[id], 20);
    if (v) slots[id] = v;
  }

  return {
    level: levelOf(surface.status, backflow.status),
    surface: surface.status,
    backflow: backflow.status,

    grid: inBox ? gridOf(lat, lon) : null,
    /* 행정동은 수천 세대 단위라 개인 식별에 쓰이지 않는다. 격자보다 읽기 쉬워서
       "어느 동이 안전하게 나왔나" 를 바로 볼 수 있다. */
    dong: statsDong && statsDong.name,
    dongCode: statsDong && statsDong.code,
    district: (statsDong && statsDong.gu) || districtOf(str((b.location || {}).address, 200)),

    depthCm: num(flood.depthCm),
    predCm: num(flood.predCm),
    traceCm: num(flood.traceCm),
    basis: str(flood.basis, 20),
    inMap: flood.inMap === true,
    covered: flood.covered === true,

    slots,
    unknownCount: num((dx.quality || {}).unknownCount) ?? 0,
    reliable: (dx.quality || {}).reliable === true,
  };
}

async function saveStats(body) {
  const doc = buildStats(body);
  doc.createdAt = FieldValue.serverTimestamp();
  const ref = await getFirestore().collection('stats').add(doc);
  return { id: ref.id, level: doc.level };
}

module.exports = { saveDiagnosis, validateAndBuild, saveStats, buildStats, levelOf, gridOf, BadRequest };
