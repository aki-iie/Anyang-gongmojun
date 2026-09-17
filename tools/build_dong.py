#!/usr/bin/env python3
"""행정동 경계 → functions/dong.json

원자료: 통계청 SGIS 행정동 경계 (공공누리 제1유형, 출처표시)
       vuski/admdongkor 가 시계열 보정·GeoJSON 변환한 배포본 (CC BY 4.0)
       https://github.com/vuski/admdongkor

전국 3,558개 행정동에서 안양시 만안구(41171)·동안구(41173)만 잘라내고,
functions/flood30.json 과 **같은 형식**으로 줄여서 저장한다.

  [ { "name":"충훈동", "gu":"만안구", "code":"4117161100",
      "polys":[ [minlon, minlat, maxlon, maxlat, [lon,lat,lon,lat,...]], ... ] }, ... ]

bbox 를 앞에 두는 이유는 functions/flood.js 와 같다 — 점 조회 때 bbox 로 먼저 거르면
링 순회를 대부분 건너뛴다.

사용법:
  python3 tools/build_dong.py                    # 최신본 내려받아 생성
  python3 tools/build_dong.py 내려받은파일.geojson  # 로컬 파일로 생성
"""
import json, math, os, sys, urllib.request

sys.setrecursionlimit(50000)

VER = 'ver20260701'
URL = f'https://raw.githubusercontent.com/vuski/admdongkor/master/{VER}/HangJeongDong_{VER}.geojson'

SGG = {'41171': '만안구', '41173': '동안구'}   # trace.json 의 sgg 코드와 같은 체계

# 단순화 허용오차(도). 위도 37.4°에서 경도 1e-5° ≈ 0.9m, 위도 1e-5° ≈ 1.1m.
# 5e-5 ≈ 5m — 행정동 판정에는 충분하고, 경계선을 눈으로 봐도 차이가 없다.
TOLERANCE = 5e-5


def rdp(pts, eps):
    """Ramer-Douglas-Peucker. pts 는 [(lon,lat), ...]"""
    if len(pts) < 3:
        return pts
    # 가장 멀리 떨어진 점 찾기
    ax, ay = pts[0]
    bx, by = pts[-1]
    dx, dy = bx - ax, by - ay
    denom = math.hypot(dx, dy)
    idx, dmax = 0, -1.0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        if denom == 0:
            d = math.hypot(px - ax, py - ay)
        else:
            d = abs(dy * px - dx * py + bx * ay - by * ax) / denom
        if d > dmax:
            idx, dmax = i, d
    if dmax <= eps:
        return [pts[0], pts[-1]]
    return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)


def ring_to_flat(ring):
    """[[lon,lat], ...] → 단순화 → (bbox, 평탄배열)"""
    pts = [(float(x), float(y)) for x, y in ring]
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    simp = rdp(pts, TOLERANCE)
    if len(simp) < 4:           # 너무 줄어 삼각형도 안 되면 원본을 쓴다
        simp = pts
    lons = [p[0] for p in simp]
    lats = [p[1] for p in simp]
    flat = []
    for x, y in simp:
        flat.append(round(x, 6))
        flat.append(round(y, 6))
    return (min(lons), min(lats), max(lons), max(lats)), flat, len(pts), len(simp)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if src and os.path.exists(src):
        raw = open(src, encoding='utf-8').read()
    else:
        print(f'내려받는 중… {URL}')
        with urllib.request.urlopen(URL, timeout=300) as r:
            raw = r.read().decode('utf-8')

    feats = json.loads(raw)['features']
    print(f'전국 행정동 {len(feats):,}개')

    out, before, after, holes = [], 0, 0, 0
    for f in feats:
        p = f['properties']
        code = str(p.get('adm_cd2') or '')
        gu = SGG.get(code[:5])
        if not gu:
            continue

        name = (p.get('adm_nm') or '').split()[-1]      # "경기도 안양시만안구 충훈동" → "충훈동"
        geom = f['geometry']
        polys_in = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]

        polys = []
        for poly in polys_in:
            # poly[0] 이 외곽선, 나머지는 구멍. 행정동에 구멍은 드물지만 있으면 세어둔다.
            if len(poly) > 1:
                holes += len(poly) - 1
            bbox, flat, n0, n1 = ring_to_flat(poly[0])
            before += n0
            after += n1
            polys.append([round(bbox[0], 6), round(bbox[1], 6),
                          round(bbox[2], 6), round(bbox[3], 6), flat])

        out.append({'name': name, 'gu': gu, 'code': code, 'polys': polys})

    out.sort(key=lambda d: (d['gu'], d['name']))

    root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    # 서버용(점 조회)과 지도용(브라우저가 직접 받는 경계선) 두 곳에 같은 파일을 쓴다.
    # 21KB 라 중복 비용이 없고, 지도를 그리려고 Cloud Function 을 한 번 더 태우지 않아도 된다.
    targets = [os.path.join(root, 'functions', 'dong.json'),
               os.path.join(root, 'public', 'dong.json')]
    body = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    for dst in targets:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'w', encoding='utf-8') as fp:
            fp.write(body)

    dst = targets[0]
    size = os.path.getsize(dst)
    print(f'안양시 행정동 {len(out)}개 · 폴리곤 {sum(len(d["polys"]) for d in out)}개'
          f' · 구멍 {holes}개')
    print(f'좌표점 {before:,} → {after:,} ({after / before:.1%}, 허용오차 {TOLERANCE}° ≈ 5m)')
    print(f'저장: functions/dong.json · public/dong.json  각 {size / 1024:.0f}KB')
    print('만안구:', ' '.join(d['name'] for d in out if d['gu'] == '만안구'))
    print('동안구:', ' '.join(d['name'] for d in out if d['gu'] == '동안구'))


if __name__ == '__main__':
    main()
