/* 침수 조회 — 서버(/api/flood)가 두 채널로 판정한다.
     채널 A 도시침수지도(예측)  30년·50년 빈도 폴리곤
     채널 B 침수흔적도(실적)    실제로 잠겼던 기록
   지도 데이터(1.2MB)는 서버에만 있고 브라우저로 내려오지 않는다. */

/** 채널 B — 실제 침수 기록 */
export type TraceResult = {
  hit: boolean;              // 이 좌표에 침수 기록이 있는가
  pts: number;               // 흔적 배점 0~30
  label: string;
  depth: number | null;      // 기록된 침수심 m
  year: string | null;       // 침수 연도
  cause: string | null;      // 피해 내용 (예: 내수침수)
  disaster: string | null;   // 재해명 (예: 8.8.~17. 호우)
  count: number;             // 겹친 기록 수
};

export type FloodResult = {
  covered: boolean;      // 안양시 만안·동안구 범위 안인가
  inMap: boolean;        // 침수 예상 구역에 포함되는가
  seg: string | null;    // N330~N334 (클수록 깊음)
  pts: number;           // 두 채널을 합친 최종 배점 0~30
  /* 무엇 때문에 점수가 나왔는지 — 결과 화면에서 근거를 갈라 보여주기 위한 값 */
  basis?: 'both' | 'map' | 'trace' | 'none';
  mapPts?: number;       // 채널 A 단독 배점
  trace?: TraceResult;   // 채널 B 판정
  label: string;
  matched?: string[];
  /* 서버가 실제로 판정한 좌표 — 화면에 띄워 두면 현장 테스트에서 원인 파악이 쉽다 */
  lat?: number;
  lon?: number;
  /* 빈도별 상세 — 30년엔 안전하지만 50년엔 잠기는 경우를 구분해서 보여준다 */
  freq30?: { inMap: boolean; seg: string | null; pts: number; label: string };
  freq50?: { inMap: boolean; seg: string | null; pts: number; label: string };
  /* shape=1 로 요청했을 때만 — 지도에 그릴 주변 폴리곤 */
  shapes?: {
    freq30: Record<string, number[][]>;
    freq50: Record<string, number[][]>;
    trace: number[][];      // 침수흔적 폴리곤 (링은 [lat,lon,...])
    radius: number;
  };
  source: string;
};

export async function lookupFlood(lat: number, lon: number, withShapes = false): Promise<FloodResult | null> {
  try {
    const q = `/api/flood?lat=${lat}&lon=${lon}` + (withShapes ? '&shape=1&radius=500' : '');
    const res = await fetch(q);
    if (!res.ok) {
      console.error('[Flood] lookup failed:', res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as FloodResult;
    console.log('[Flood]', data);
    return data;
  } catch (err) {
    console.error('[Flood] exception:', err);
    return null;
  }
}

/** URL 에 ?lat=&lon= 이 있으면 그 좌표를 쓴다.
    안양 현지에 가지 않고도 확인·시연할 수 있게 하는 장치다.
    ?acc= 로 GPS 오차 반경(m)도 흉내낼 수 있다. */
export function coordsFromUrl(): { lat: number; lon: number; accuracy: number } | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  const rawLat = q.get('lat'), rawLon = q.get('lon');
  /* 파라미터가 아예 없으면 null 이고 Number(null) 은 0 이다.
     그대로 두면 좌표가 없을 때 (0,0) 이 유효값으로 통과해 GPS 를 건너뛴다. */
  if (rawLat === null || rawLon === null) return null;
  if (rawLat.trim() === '' || rawLon.trim() === '') return null;
  const lat = Number(rawLat), lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;   // 대서양 한복판 — 실수로 들어온 값
  const acc = Number(q.get('acc'));
  return { lat, lon, accuracy: Number.isFinite(acc) && acc > 0 ? acc : 20 };
}

/* 위치 실패 사유 — 화면에서 안내를 갈라 보여주기 위해 코드를 함께 넘긴다 */
export type GeoFailure = 'denied' | 'unavailable' | 'timeout' | 'unsupported';
export class GeoError extends Error {
  kind: GeoFailure;
  constructor(kind: GeoFailure, message: string) { super(message); this.kind = kind; }
}

/** 기기·브라우저를 보고 위치 켜는 경로를 알려준다 */
export function locationHelp(): { device: string; steps: string[] } {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);

  if (iOS) {
    return {
      device: 'iPhone · iPad',
      steps: [
        '설정 → 개인정보 보호 및 보안 → 위치 서비스를 켭니다',
        '같은 화면 아래 목록에서 Safari(또는 쓰는 브라우저) → "앱을 사용하는 동안" 선택',
        '이 페이지로 돌아와 주소창 왼쪽 「아A」 → 웹사이트 설정 → 위치 → 허용',
        '새로고침 후 버튼을 다시 눌러 주세요',
      ],
    };
  }
  if (android) {
    return {
      device: 'Android',
      steps: [
        '설정 → 위치 를 켭니다 (빠른 설정의 위치 아이콘도 됩니다)',
        '주소창 왼쪽 자물쇠(또는 ⓘ) → 권한 → 위치 → 허용',
        '새로고침 후 버튼을 다시 눌러 주세요',
      ],
    };
  }
  return {
    device: 'PC',
    steps: [
      '주소창 왼쪽 자물쇠(또는 ⓘ) 아이콘을 누릅니다',
      '위치 항목을 "허용"으로 바꿉니다',
      'macOS 라면 시스템 설정 → 개인정보 보호 및 보안 → 위치 서비스도 켜져 있어야 합니다',
      '새로고침 후 버튼을 다시 눌러 주세요',
    ],
  };
}

/** 권한 상태를 미리 확인한다. 지원하지 않는 브라우저면 null. */
export async function checkPermission(): Promise<'granted' | 'denied' | 'prompt' | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return null;
    const r = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return r.state as 'granted' | 'denied' | 'prompt';
  } catch { return null; }
}

/** 브라우저 위치 권한으로 현재 좌표를 얻는다. 키가 필요 없다.
    URL 좌표가 주어졌으면 그쪽이 우선한다.
    첫 호출이면 브라우저가 스스로 권한 팝업을 띄운다 — 코드로 강제할 수는 없다. */
export function getCurrentPosition(): Promise<{ lat: number; lon: number; accuracy: number }> {
  const forced = coordsFromUrl();
  if (forced) return Promise.resolve(forced);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new GeoError('unsupported', '이 브라우저는 위치 확인을 지원하지 않아요.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => {
        if (e.code === e.PERMISSION_DENIED) {
          reject(new GeoError('denied', '위치 사용이 꺼져 있어요. 아래 순서로 켜 주세요.'));
        } else if (e.code === e.POSITION_UNAVAILABLE) {
          reject(new GeoError('unavailable', '위치를 찾지 못했어요. 기기의 위치 서비스가 꺼져 있거나 신호가 약할 수 있어요.'));
        } else {
          reject(new GeoError('timeout', '위치 확인이 오래 걸려 멈췄어요. 창가에서 다시 시도해 보세요.'));
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}
