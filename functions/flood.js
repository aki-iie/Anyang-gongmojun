/* 침수심 조회 — 두 채널
   채널 A 도시침수지도(예측): 국가공간정보 도시침수지도 SHP (EPSG:5186) → WGS84 변환본
   채널 B 침수흔적도(실측)  : 재난안전데이터공유플랫폼 DSSP-IF-00117 (EPSG:3857) → WGS84 변환본
   대상: 안양시 만안구(41171) · 동안구(41173)

   판정은 하지 않는다. 판정 엔진(src/utils/diagnose.ts)이 받는 "침수심(cm)" 만 만든다.
   SEG_CODE N330~N334 는 침수심 등급이며 숫자가 클수록 깊다.
   (면적 역순 + 포함관계로 확인. 각 등급의 정확한 m 구간은 원본 범례로 확정 필요) */

const DATA = {
  '030': require('./flood30.json'),
  '050': require('./flood50.json'),
};

/* 채널 B — 실제로 잠겼던 기록. 전국 38,003건 중 안양시 8건 (tools/build_trace.py 가 만든다).
   채널 A 는 "예측", 채널 B 는 "실측"이라 둘은 일치하지 않는다.
   석수동 충훈부 일대 5건은 2022년에 20~33cm 잠겼지만 채널 A 에서는 침수 구역이 아니다. */
const TRACE = require('./trace.json');

/* 등급 → 대표 침수심(cm).
   ⚠ 공식 범례값이 아니라 가정값이다 (scripts/DS2_spatial_grid_analysis.ipynb 셀 7 과 같은 값).
   근거가 확정되면 이 표 한 곳만 고친다. 노트북 쪽 값도 함께 맞출 것. */
const SEG_DEPTH_CM = { N330: 20, N331: 40, N332: 60, N333: 100, N334: 150 };

const SEG_LABEL = {
  N334: '가장 깊은 침수 예상 구간',
  N333: '매우 깊은 침수 예상 구간',
  N332: '깊은 침수 예상 구간',
  N331: '중간 침수 예상 구간',
  N330: '얕은 침수 예상 구간',
};
const ORDER = ['N334', 'N333', 'N332', 'N331', 'N330'];
const FREQ_YEARS = { '030': 30, '050': 50 };

/* 흔적 폴리곤은 한 변 30~60m 로 작다. 바로 옆집은 폴리곤 밖으로 빠진다.
   측정되지 않은 집에 남의 집 침수심을 넣으면 과장이므로, 이 반경 안이면 경고만 한다. */
const NEAR_TRACE_M = 100;

/** ray casting (even-odd). ring 은 [lon,lat,lon,lat,...] 평탄 배열 */
function inRing(lon, lat, flat) {
  let inside = false;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[i * 2], yi = flat[i * 2 + 1];
    const xj = flat[j * 2], yj = flat[j * 2 + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 점에서 링 경계까지의 최단거리(m). 수백 m 범위라 등장방형 근사로 충분하다. */
function distToRing(lon, lat, flat) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  let best = Infinity;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = (flat[j * 2] - lon) * kx, ay = (flat[j * 2 + 1] - lat) * ky;
    const bx = (flat[i * 2] - lon) * kx, by = (flat[i * 2 + 1] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/**
 * 채널 A — 좌표의 예상 침수 등급. 겹치는 등급이 있으면 가장 깊은 쪽을 채택(보수적).
 * @returns {{inMap:boolean, seg:string|null, depthCm:number, label:string, matched:string[]}}
 */
function classify(lon, lat, freq = '030') {
  const RINGS = DATA[freq] || DATA['030'];
  const years = FREQ_YEARS[freq] || 30;
  const matched = [];
  for (const seg of ORDER) {
    const arr = RINGS[seg];
    if (!arr) continue;
    for (let k = 0; k < arr.length; k++) {
      const [x0, y0, x1, y1, flat] = arr[k];
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
      if (inRing(lon, lat, flat)) { matched.push(seg); break; }
    }
  }
  if (!matched.length) {
    return {
      inMap: false, seg: null, depthCm: 0, matched: [],
      label: `${years}년 빈도 강우 시 침수 예상 구역에 포함되지 않음`,
    };
  }
  const seg = matched[0];
  return { inMap: true, seg, depthCm: SEG_DEPTH_CM[seg], label: SEG_LABEL[seg], matched };
}

/**
 * 채널 B — 침수흔적. 겹치는 기록이 여럿이면 가장 깊은 쪽을 채택(보수적).
 * 폴리곤 밖이면 반경 NEAR_TRACE_M 안의 가장 가까운 기록을 near 로 알려준다(판정에는 쓰지 않는다).
 * @returns {{hit:boolean, depthCm:number|null, label:string, year:string|null, cause:string|null,
 *            disaster:string|null, count:number, near:{distM:number, depthCm:number, year:string|null}|null}}
 */
function classifyTrace(lon, lat) {
  const hits = [];
  for (const t of TRACE) {
    const [x0, y0, x1, y1] = t.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (inRing(lon, lat, t.ring)) hits.push(t);
  }
  if (!hits.length) {
    let near = null;
    const dLat = NEAR_TRACE_M / 110540;
    const dLon = NEAR_TRACE_M / (111320 * Math.cos((lat * Math.PI) / 180));
    for (const t of TRACE) {
      const [x0, y0, x1, y1] = t.bbox;
      if (lon < x0 - dLon || lon > x1 + dLon || lat < y0 - dLat || lat > y1 + dLat) continue;
      const d = distToRing(lon, lat, t.ring);
      if (d <= NEAR_TRACE_M && (!near || d < near.distM)) {
        near = { distM: Math.round(d), depthCm: Math.round(Number(t.depth) * 1000) / 10, year: t.year || null };
      }
    }
    return {
      hit: false, depthCm: null, year: null, cause: null, disaster: null, count: 0, near,
      label: '기록에 남은 침수 이력은 없음',
    };
  }
  /* trace.json 은 침수심 내림차순으로 저장돼 있지만, 의존하지 않고 여기서 다시 고른다. */
  const top = hits.reduce((a, b) => ((Number(b.depth) || 0) > (Number(a.depth) || 0) ? b : a));
  return {
    hit: true,
    depthCm: Math.round(Number(top.depth) * 1000) / 10,   // 0.262m → 26.2cm
    label: '실제로 잠겼던 기록이 있는 곳',
    year: top.year || null,
    cause: top.cause || null,
    disaster: top.disaster || null,
    count: hits.length,
    near: null,
  };
}

/**
 * 두 채널을 판정용 침수심 하나로 합친다.
 * 실측은 "실제로 이만큼 잠겼다"는 하한선이라, 예측이 0 이어도 버리지 않는다 — 큰 값을 쓴다.
 * @returns {{depthCm:number, basis:'both'|'map'|'trace'|'none'}}
 */
/* 예측(채널 A)과 실측(채널 B) 중 큰 값을 판정 침수심으로 쓴다.
   ⚠ 두 값은 **빈도가 다르다.** 예측은 30·50년 빈도 도시침수지도이고,
   실측은 2022년 8월 호우 기록인데 이 사건은 약 90년 빈도로 추정된다.
   즉 실측이 예측보다 크게 나오는 것은 오류가 아니라 정상이다.
   그럼에도 큰 쪽을 쓰는 이유는 거주자 안전이다 — 실제로 그만큼 잠겼던 기록이
   있는 자리를 "예측 구역이 아니므로 안전" 으로 판정하면 안 된다.
   (안양시 침수흔적 8건 중 6건이 예측지도 밖이다. README §6 참고) */
function mergeDepth(predCm, traceCm) {
  const p = predCm || 0, t = traceCm || 0;
  const basis = p > 0 && t > 0 ? 'both' : p > 0 ? 'map' : t > 0 ? 'trace' : 'none';
  return { depthCm: Math.max(p, t), basis };
}

/** 지도 표시용 — 반경 안에 걸치는 흔적 폴리곤. 링은 [lat,lon,...] (Leaflet 순서) */
function tracesNear(lon, lat, radiusM = 500) {
  const dLat = radiusM / 111000;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const x0 = lon - dLon, x1 = lon + dLon, y0 = lat - dLat, y1 = lat + dLat;
  const out = [];
  for (const t of TRACE) {
    const [bx0, by0, bx1, by1] = t.bbox;
    if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
    const flat = t.ring;
    const latlng = new Array(flat.length);
    for (let i = 0; i < flat.length; i += 2) {
      latlng[i] = flat[i + 1];
      latlng[i + 1] = flat[i];
    }
    out.push(latlng);
  }
  return out;
}

/* 안양시 행정구역을 넉넉히 덮는 범위.
   주의 — 이 값은 "침수 예상 구역"의 bbox 가 아니다.
   침수구역 bbox(경도 126.899~126.981)로 잡으면 침수 구역 밖에 사는
   안양시민 대부분이 "판정 범위 밖"으로 잘려나간다. */
const COVER = { lon: [126.84, 127.03], lat: [37.32, 37.48] };
function inCoverage(lon, lat) {
  return lon >= COVER.lon[0] && lon <= COVER.lon[1] && lat >= COVER.lat[0] && lat <= COVER.lat[1];
}

/**
 * 지도 표시용 — 중심 좌표 주변 반경 안에 걸치는 폴리곤만 잘라서 돌려준다.
 * 전체(1.2MB)를 브라우저에 내리지 않기 위한 것이다.
 * @returns {{ [seg:string]: number[][] }}  각 링은 [lat,lon,lat,lon,...] (Leaflet 순서)
 */
function shapesNear(lon, lat, freq = '030', radiusM = 500) {
  const RINGS = DATA[freq] || DATA['030'];
  const dLat = radiusM / 111000;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const x0 = lon - dLon, x1 = lon + dLon, y0 = lat - dLat, y1 = lat + dLat;
  const out = {};
  for (const seg of ORDER) {
    const arr = RINGS[seg];
    if (!arr) continue;
    const keep = [];
    for (const [bx0, by0, bx1, by1, flat] of arr) {
      if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;  // bbox 교차 없음
      const latlng = new Array(flat.length);
      for (let i = 0; i < flat.length; i += 2) {
        latlng[i] = flat[i + 1];      // lat
        latlng[i + 1] = flat[i];      // lon
      }
      keep.push(latlng);
    }
    if (keep.length) out[seg] = keep;
  }
  return out;
}

module.exports = {
  classify, inCoverage, shapesNear,
  classifyTrace, tracesNear, mergeDepth,
  SEG_DEPTH_CM, COVER, FREQS: Object.keys(DATA), TRACE_COUNT: TRACE.length,
};
