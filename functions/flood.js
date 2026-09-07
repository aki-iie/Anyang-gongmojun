/* 도시침수지도(30년 빈도) 좌표 판정
   원본: 국가공간정보 도시침수지도 SHP (EPSG:5186) → WGS84 GeoJSON 변환본
   대상: 안양시 만안구(41171) · 동안구(41173)

   SEG_CODE N330~N334 는 침수심 등급이며 숫자가 클수록 깊다.
   (면적 역순 + 포함관계로 확인. 각 등급의 정확한 m 구간은 원본 범례로 확정 필요) */

const DATA = {
  '030': require('./flood30.json'),
  '050': require('./flood50.json'),
};

/* ── 채널 B: 침수흔적도(실제로 잠겼던 기록) ─────────────────────────
   출처: 재난안전데이터공유플랫폼 DSSP-IF-00117, 전국 38,003건 중 안양시 8건.
   원본 좌표계는 EPSG:3857 이고 tools/build_trace.py 가 WGS84 로 변환해 둔다.

   채널 A(도시침수지도)는 "예측", 채널 B는 "실적"이다. 둘은 일치하지 않는다.
   실제로 안양시 8건 중 만안구 박달동 6건은 채널 A 에서 침수 구역이 아니다.
   예측지도만 믿으면 2022년에 실제로 잠겼던 골목이 0점으로 나온다. */
const TRACE = require('./trace.json');

/* 기록된 침수심(m) → 배점. 반지하는 0.2m 만 차도 실내로 들어온다. */
function traceLevel(depth) {
  const d = Number(depth) || 0;
  if (d >= 0.5) return { pts: 30, label: '0.5m 이상 잠겼던 기록이 있는 곳' };
  if (d >= 0.3) return { pts: 25, label: '무릎 아래까지 잠겼던 기록이 있는 곳' };
  if (d >= 0.2) return { pts: 20, label: '발목 위까지 잠겼던 기록이 있는 곳' };
  if (d >= 0.1) return { pts: 15, label: '발목까지 잠겼던 기록이 있는 곳' };
  return { pts: 12, label: '침수 기록이 있는 곳' };
}

/* 등급별 배점 — 총점 100 중 침수지도 몫 0~30.
   실제 m 구간이 확인되면 이 표만 고치면 된다. */
const LEVEL = {
  N334: { pts: 30, label: '가장 깊은 침수 예상 구간' },
  N333: { pts: 28, label: '매우 깊은 침수 예상 구간' },
  N332: { pts: 25, label: '깊은 침수 예상 구간' },
  N331: { pts: 20, label: '중간 침수 예상 구간' },
  N330: { pts: 12, label: '얕은 침수 예상 구간' },
};
const ORDER = ['N334', 'N333', 'N332', 'N331', 'N330'];

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

/**
 * 좌표의 침수 등급을 판정한다. 겹치는 등급이 있으면 가장 깊은 쪽을 채택(보수적).
 * @returns {{inMap:boolean, seg:string|null, pts:number, label:string, matched:string[]}}
 */
function classify(lon, lat, freq = '030') {
  const RINGS = DATA[freq] || DATA['030'];
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
      inMap: false, seg: null, pts: 0, matched: [],
      label: '30년 빈도 강우 시 침수 예상 구역에 포함되지 않음',
    };
  }
  const seg = matched[0];
  return { inMap: true, seg, pts: LEVEL[seg].pts, label: LEVEL[seg].label, matched };
}

/**
 * 침수흔적 판정 — 겹치는 기록이 여럿이면 가장 깊은 쪽을 채택(보수적).
 * @returns {{hit:boolean, pts:number, label:string, depth:number|null, year:string|null,
 *            cause:string|null, disaster:string|null, count:number}}
 */
function classifyTrace(lon, lat) {
  const hits = [];
  for (const t of TRACE) {
    const [x0, y0, x1, y1] = t.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (inRing(lon, lat, t.ring)) hits.push(t);
  }
  if (!hits.length) {
    return {
      hit: false, pts: 0, depth: null, year: null, cause: null, disaster: null, count: 0,
      label: '기록에 남은 침수 이력은 없음',
    };
  }
  /* trace.json 은 침수심 내림차순으로 저장돼 있지만, 의존하지 않고 여기서 다시 고른다. */
  const top = hits.reduce((a, b) => ((Number(b.depth) || 0) > (Number(a.depth) || 0) ? b : a));
  const lv = traceLevel(top.depth);
  return {
    hit: true, pts: lv.pts, label: lv.label,
    depth: Number(top.depth) || null,
    year: top.year || null,
    cause: top.cause || null,
    disaster: top.disaster || null,
    count: hits.length,
  };
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

/**
 * 두 채널을 하나의 지도 배점(0~30)으로 합친다.
 *
 * 단순히 더하지 않는 이유 — 결과 화면이 총점을 "/100" 으로 보여주는데
 * 현재 최대가 95점(지도30+현관30+창문20+이력15)이라 더하면 100을 넘는다.
 * 그래서 더 높은 쪽을 취하고, 예측과 실적이 겹치면 5점만 가산한다.
 *
 * @returns {{pts:number, basis:'both'|'map'|'trace'|'none'}}
 */
function combine(mapPts, tracePts) {
  const both = mapPts > 0 && tracePts > 0;
  const pts = Math.min(30, Math.max(mapPts, tracePts) + (both ? 5 : 0));
  const basis = both ? 'both' : mapPts > 0 ? 'map' : tracePts > 0 ? 'trace' : 'none';
  return { pts, basis };
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
  classifyTrace, tracesNear, combine,
  LEVEL, COVER, FREQS: Object.keys(DATA), TRACE_COUNT: TRACE.length,
};
