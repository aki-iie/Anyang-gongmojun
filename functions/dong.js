/* 행정동 판정 — 좌표 하나로 안양시 행정동을 찾는다.

   원자료: 통계청 SGIS 행정동 경계(공공누리 제1유형) → vuski/admdongkor 배포본(CC BY 4.0)
   가공:   tools/build_dong.py 가 안양시 만안구(41171)·동안구(41173) 31개만 잘라
           functions/flood30.json 과 같은 형식으로 줄인다 (21KB).

   왜 지오코더를 안 쓰는가
     VWorld 로 주소에서 동을 받아오면 (1) 요청이 한 번 더 들고, (2) GPS 로 들어온
     사용자는 주소가 없어 동을 못 채우고, (3) 주소 문자열 파싱에 기대게 된다.
     좌표는 두 경로 모두 항상 있으므로, 침수 판정과 똑같이 점-in-폴리곤으로 푸는 편이
     빠르고 빈틈이 없다.

   ⚠ 행정동이다. 법정동이 아니다.
     충훈동은 법정동으로는 없지만 행정동으로는 실재한다(만안구, 옛 석수3동).
     침수흔적도 8건은 법정동 기준으로 석수동 5·박달동 1·비산동 2 인데,
     같은 지점을 행정동으로 보면 다른 이름이 나올 수 있다. 섞어 쓰지 말 것. */

const DONGS = require('./dong.json');

/** ray casting (even-odd). ring 은 [lon,lat,lon,lat,...] 평탄 배열 — flood.js 와 같은 방식 */
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
 * 좌표 → 행정동. 안양시 밖이거나 경계 밖이면 null.
 * @returns {{name:string, gu:string, code:string}|null}
 */
function dongOf(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  for (const d of DONGS) {
    for (const [x0, y0, x1, y1, flat] of d.polys) {
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;   // bbox 로 먼저 거른다
      if (inRing(lon, lat, flat)) return { name: d.name, gu: d.gu, code: d.code };
    }
  }
  return null;
}

/** 행정동 목록 — 관리자 화면의 필터 선택지로 쓴다(경계 좌표는 빼고 이름만) */
function dongList() {
  return DONGS.map((d) => ({ name: d.name, gu: d.gu, code: d.code }));
}

module.exports = { dongOf, dongList };
