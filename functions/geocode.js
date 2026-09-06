/* 주소 → 좌표 (VWorld 지오코더)
   도로명으로 먼저 찾고, 못 찾으면 지번으로 한 번 더 시도한다. */

const ENDPOINT = 'https://api.vworld.kr/req/address';

async function lookup(address, type, key) {
  const q = new URLSearchParams({
    service: 'address', request: 'getcoord', version: '2.0',
    crs: 'epsg:4326', format: 'json', type, address, key,
  });
  const r = await fetch(`${ENDPOINT}?${q}`);
  if (!r.ok) return null;
  const d = await r.json();
  if (d?.response?.status !== 'OK') return null;
  const p = d.response.result?.point;
  if (!p) return null;
  const lat = Number(p.y), lon = Number(p.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, refined: d.response.refined?.text || address, matched: type };
}

/** @returns {{lat,lon,refined,matched}|null} */
async function geocode(address) {
  const key = process.env.VWORLD_KEY;
  if (!key) { console.error('VWORLD_KEY 가 설정되지 않았습니다.'); return null; }
  const a = String(address || '').trim();
  if (!a || a.length > 200) return null;
  return (await lookup(a, 'ROAD', key)) || (await lookup(a, 'PARCEL', key));
}

module.exports = { geocode };
