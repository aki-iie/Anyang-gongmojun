import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/* 등급별 색 — 깊을수록 진하다 */
const COLOR: Record<string, string> = {
  N330: '#d3e3ef', N331: '#a2c6de', N332: '#6ea3c6', N333: '#3d79a6', N334: '#1f4f78',
};
const ORDER = ['N330', 'N331', 'N332', 'N333', 'N334'];

/* 배경지도 타일.
   VITE_TILE_URL 이 있으면 그 타일을, 없으면 배경 없이 침수 구역만 그린다.
   VWorld WMTS: .../1.0.0/{키}/{Base|midnight|white|Hybrid|Satellite}/{z}/{y}/{x}.png
   Base 는 건물명·시설명까지 한글로 나온다. 다크 테마에서는 midnight 으로 바꿔 쓴다. */
const TILE_URL: string | undefined = import.meta.env.VITE_TILE_URL;
const TILE_ATTR: string = import.meta.env.VITE_TILE_ATTR ?? '';

const isDark = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;

const tileFor = (dark: boolean) =>
  TILE_URL && dark ? TILE_URL.replace('/Base/', '/midnight/') : TILE_URL;

export type FloodShapes = Record<string, number[][]>;

type Props = {
  lat: number;
  lon: number;
  accuracy?: number;
  shapes?: FloodShapes;
  zoom?: number;
  height?: number;
  /* 위치 확인 단계에서는 false — 깨끗한 지도만 보여준다.
     결과 단계에서만 침수 레이어를 얹는다. */
  overlay?: boolean;
  /* 핀 위에 새길 등급·배점 배지 */
  badge?: { seg: string | null; pts: number } | null;
};

export default function FloodMap({
  lat, lon, accuracy = 0, shapes, zoom = 16, height = 210,
  overlay = false, badge = null,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /* 지도 생성 — 한 번만 */
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    const map = L.map(boxRef.current, {
      center: [lat, lon],
      zoom,
      zoomControl: true,
      attributionControl: !!TILE_ATTR,
      scrollWheelZoom: false,   // 페이지 스크롤을 뺏지 않는다
      minZoom: 13,
      maxZoom: 18,
    });
    if (TILE_URL) {
      const tile = L.tileLayer(tileFor(isDark())!, { maxZoom: 19, attribution: TILE_ATTR }).addTo(map);
      /* 테마가 바뀌면 배경지도도 같이 갈아끼운다 */
      const mq = matchMedia('(prefers-color-scheme: dark)');
      const onTheme = () => tile.setUrl(tileFor(mq.matches)!);
      mq.addEventListener('change', onTheme);
      map.once('unload', () => mq.removeEventListener('change', onTheme));
    }
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    /* 카드가 펼쳐지는 애니메이션이 끝난 뒤 크기를 다시 잡아야 타일·중심이 어긋나지 않는다 */
    setTimeout(() => map.invalidateSize(), 60);
    setTimeout(() => map.invalidateSize(), 600);
    return () => { timers.current.forEach(clearTimeout); map.remove(); mapRef.current = null; };
    /* 지도는 한 번만 만든다. 좌표·배율 갱신은 아래 effect 가 맡는다. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 위치·폴리곤 갱신 */
  useEffect(() => {
    const map = mapRef.current, group = layerRef.current;
    if (!map || !group) return;
    group.clearLayers();
    timers.current.forEach(clearTimeout);
    timers.current = [];

    if (overlay && shapes) {
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      /* 얕은 등급부터 차례로 얹어 물이 차오르는 느낌을 준다 */
      ORDER.forEach((seg, i) => {
        const rings = shapes[seg];
        if (!rings) return;
        const paint = () => {
          for (const flat of rings) {
            const pts: [number, number][] = [];
            for (let k = 0; k < flat.length; k += 2) pts.push([flat[k], flat[k + 1]]);
            L.polygon(pts, {
              color: COLOR[seg], weight: 1, opacity: 0.85,
              fillColor: COLOR[seg], fillOpacity: 0.6,
            }).addTo(group);
          }
        };
        if (reduce) paint();
        else timers.current.push(setTimeout(paint, 80 + i * 95));
      });
    }

    if (accuracy > 0) {
      L.circle([lat, lon], {
        radius: accuracy, color: '#b4452f', weight: 1.5, opacity: 0.5,
        fillColor: '#b4452f', fillOpacity: 0.12,
      }).addTo(group);
    }
    L.circleMarker([lat, lon], {
      radius: 7, color: '#fff', weight: 3, fillColor: '#b4452f', fillOpacity: 1,
    }).addTo(group);

    /* 점수 배지 — 지도를 다 읽은 뒤 결론이 도착하는 순서로 늦게 띄운다 */
    if (badge) {
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const label = badge.seg ? `${badge.seg} · <b style="color:#b4452f">+${badge.pts}점</b>`
                              : `침수 구역 아님 · <b style="color:#b4452f">+0점</b>`;
      const html =
        `<div style="transform:translate(-50%,-100%) translateY(-10px);white-space:nowrap;` +
        `background:var(--color-bg);border:1.5px solid #b4452f;border-radius:9px;padding:5px 10px;` +
        `font-size:13px;font-weight:600;font-family:inherit;color:var(--color-text);` +
        `box-shadow:0 4px 12px rgba(0,0,0,.22)">${label}</div>`;
      const show = () =>
        L.marker([lat, lon], {
          icon: L.divIcon({ className: '', html, iconSize: [0, 0] }),
          interactive: false, zIndexOffset: 800,
        }).addTo(group);
      if (reduce) show();
      else timers.current.push(setTimeout(show, 560));
    }

    map.setView([lat, lon], zoom);
    map.invalidateSize();
    /* badge 객체는 매 렌더 새로 만들어지므로 값(seg·pts)만 의존성으로 둔다. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon, accuracy, shapes, zoom, overlay, badge?.seg, badge?.pts]);

  return (
    <div style={{ position: 'relative', height }}>
      <div ref={boxRef} style={{ height: '100%', width: '100%', background: 'var(--color-neutral-200)' }} />
      {!TILE_URL && (
        <span style={{
          position: 'absolute', left: 8, bottom: 8, zIndex: 500,
          fontSize: 11, color: 'var(--color-neutral-600)',
          background: 'rgba(247,245,240,.86)', padding: '3px 7px', borderRadius: 5,
        }}>
          배경지도 없음 · 침수 예상 구역만 표시
        </span>
      )}
    </div>
  );
}
