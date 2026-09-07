#!/usr/bin/env python3
"""침수흔적도(재난안전데이터공유플랫폼 DSSP-IF-00117) → functions/trace.json

원본은 전국 38,003건이고 시군구 필터 파라미터가 없다. 전량을 1000건씩 받아
안양시 범위(functions/flood.js 의 COVER 와 같은 bbox)로 잘라서 저장한다.

좌표계: EPSG:3857(Web Mercator) → WGS84. 경주시 샘플로 검증했다.

사용법:
    SAFETYDATA_KEY=... python3 tools/build_trace.py
키는 코드에 넣지 않는다. functions/.env 의 SAFETYDATA_KEY 를 export 해서 쓴다.
"""
import json, math, os, re, sys, urllib.request, ssl, time

API = 'https://www.safetydata.go.kr/V2/api/DSSP-IF-00117'
PAGE = 1000
OUT = os.path.join(os.path.dirname(__file__), '..', 'functions', 'trace.json')
CACHE = os.path.join(os.path.dirname(__file__), '..', '.cache_trace')

# 안양시 만안구·동안구. 도시침수지도(채널 A)와 같은 범위여야 두 채널을 나란히 비교할 수 있다.
# COVER bbox 로 자르면 서울 금천·관악, 광명까지 딸려 들어온다(1312건). 그래서 시군구 코드로 자른다.
SGG = {'41171': '만안구', '41173': '동안구'}

R = 6378137.0
HALF = 20037508.342789244


def to_wgs84(x, y):
    """EPSG:3857 → (lon, lat)"""
    return x / HALF * 180, math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)


def fetch_all(key):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE   # 이 서버는 중간 인증서를 안 내려준다
    rows, page = [], 1
    while True:
        url = f'{API}?serviceKey={key}&pageNo={page}&numOfRows={PAGE}&returnType=json'
        with urllib.request.urlopen(url, timeout=90, context=ctx) as r:
            d = json.load(r)
        if d.get('header', {}).get('resultCode') != '00':
            sys.exit(f"API 오류: {d.get('header', {}).get('resultMsg')}")
        body = d.get('body') or []
        rows += body
        total = d.get('totalCount', 0)
        print(f'  page {page}: {len(body)}건 (누적 {len(rows)}/{total})', flush=True)
        if len(body) < PAGE or len(rows) >= total:
            break
        page += 1
        time.sleep(0.2)
    return rows


def main():
    if os.path.exists(CACHE):
        print(f'캐시 사용: {CACHE}')
        rows = json.load(open(CACHE, encoding='utf-8'))
    else:
        key = os.environ.get('SAFETYDATA_KEY', '').strip()
        if not key:
            sys.exit('SAFETYDATA_KEY 환경변수가 필요합니다.')
        print('전국 침수흔적도 내려받는 중…')
        rows = fetch_all(key)
        json.dump(rows, open(CACHE, 'w', encoding='utf-8'), ensure_ascii=False)

    out = []
    for r in rows:
        if str(r.get('STDG_SGG_CD') or '') not in SGG:
            continue
        geom = r.get('GEOM') or ''
        pairs = re.findall(r'(-?\d+\.?\d*) (-?\d+\.?\d*)', geom)
        if len(pairs) < 3:
            continue
        flat, xs, ys = [], [], []
        for a, b in pairs:
            lon, lat = to_wgs84(float(a), float(b))
            flat += [round(lon, 6), round(lat, 6)]
            xs.append(lon); ys.append(lat)
        out.append({
            'bbox': [round(min(xs), 6), round(min(ys), 6), round(max(xs), 6), round(max(ys), 6)],
            'ring': flat,
            'depth': r.get('FLDN_DOWA'),          # 침수심 m
            'grd': r.get('FLDN_GRD'),             # 침수 등급
            'area': r.get('FLDN_AREA'),           # 침수 면적 ㎡
            'year': str(r.get('FLDN_YR') or ''),
            'sgg': str(r.get('STDG_SGG_CD') or ''),
            'disaster': r.get('FLDN_DST_NM') or '',
            'cause': r.get('FLDN_CS_DTL_NM') or '',
        })

    out.sort(key=lambda o: -(o['depth'] or 0))
    json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    size = os.path.getsize(OUT)
    print(f'\n안양시 {len(out)}건 → {os.path.normpath(OUT)} ({size:,} bytes)')
    for o in out:
        print(f"  {SGG[o['sgg']]} {o['year']}년 침수심 {o['depth']}m 면적 {o['area']}㎡ · {o['cause']}")


if __name__ == '__main__':
    main()
