#!/usr/bin/env python3
"""개구부 방어높이 격자 분석 — 판정이 어디서 뒤집히는가

무엇을 계산하나
  경로 A(지표 유입) 판정은 `예상침수심 > 실효 방어높이` 뺄셈 하나다.
  그리고 실효 방어높이는 슬롯 **네 개**로만 정해진다.
      entrance_sill · water_panel · window_base · window_barrier
  그래서 가능한 조합이 유한하고(48가지), 전수 열거가 가능하다.

왜 하나
  도시침수지도 등급 → cm 환산값(SEG_DEPTH_CM)이 아직 확정되지 않았다.
  이 스크립트는 그 값을 **미지수로 두고** 침수심을 0~60cm로 훑으면서
  "몇 %가 유입가능으로 뒤집히는가"를 계산한다. 결론이 그 미지수에 얼마나
  민감한지를 보여주는 게 목적이다. 값이 확정되면 표에서 해당 열만 읽으면 된다.

값을 복제하지 않는다
  cm 환산표(SILL_CM 등)를 여기에 다시 쓰지 않고 scripts/diagnose.py 를
  그대로 import 해서 쓴다. 엔진이 바뀌면 이 분석도 자동으로 따라간다.
  (차동현 담당 파일 — 읽기만 하고 수정하지 않는다)

현장조사 데이터가 있으면
  field_survey_45.csv 가 있으면 조합별 실제 출현 빈도로 가중해 다시 계산한다.
  없으면 조합 전수(= 모든 조합이 똑같이 흔하다는 가정) 기준으로만 낸다.
  **전수 기준 비율을 "안양 반지하의 X%" 라고 말하면 안 된다.** 가중 계산이
  나오기 전까지는 "가능한 조합 중 X%" 까지만 말할 수 있다.

사용법
  python3 tools/defense_lattice.py                      # 조합 전수만
  python3 tools/defense_lattice.py field_survey_45.csv  # 실측 가중
"""
import csv
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

try:
    from diagnose import diagnose, ALLOWED, SLOT_IDS      # noqa: E402
except ImportError as e:
    sys.exit(f'scripts/diagnose.py 를 불러오지 못했습니다: {e}')

# 방어높이를 결정하는 네 슬롯. 나머지 8개는 경로 A 뺄셈에 들어가지 않는다.
DEFENSE_SLOTS = ['entrance_sill', 'water_panel', 'window_base', 'window_barrier']

# 현장조사 CSV 가 영문 컬럼명이 아닐 수 있어 한글 헤더도 받는다.
KO_HEADER = {
    '턱': 'entrance_sill', '현관턱': 'entrance_sill', '현관 턱': 'entrance_sill',
    '계단': 'stair_count',
    '물막이판': 'water_panel',
    '창문': 'window_base', '창문하단': 'window_base',
    '차수막': 'window_barrier',
    '경사': 'road_slope', '골목경사': 'road_slope',
    '빗물받이': 'drain_status',
    '차양': 'canopy',
}

# 안양시 침수흔적도 8건(2022년 8월 호우)의 실측 침수심 범위 — functions/trace.json
TRACE_MIN_CM, TRACE_MAX_CM = 9.3, 33.0


def real_values(slot):
    """unknown 을 뺀 실제 선택지"""
    return [v for v in ALLOWED[slot] if v != 'unknown']


def all_combos():
    """방어높이를 정하는 네 슬롯의 모든 조합 → (조합dict, 실효방어높이, 최약점)"""
    out = []
    for sill in real_values('entrance_sill'):
        for panel in real_values('water_panel'):
            for wbase in real_values('window_base'):
                for barrier in real_values('window_barrier'):
                    slots = {'entrance_sill': sill, 'water_panel': panel,
                             'window_base': wbase, 'window_barrier': barrier}
                    # 침수심을 주지 않으면 status 는 '확인필요'지만
                    # effective_defense_cm 은 그대로 계산된다.
                    r = diagnose(dict(slots), None, None)['surface']
                    out.append((slots, r['effective_defense_cm'], r['weakest_point']))
    return out


def load_survey(path):
    """현장조사 CSV → 네 슬롯 조합의 출현 횟수. 허용 밖 값은 unknown 으로 본다."""
    rows, skipped = [], 0
    with open(path, encoding='utf-8-sig') as fp:
        for row in csv.DictReader(fp):
            norm = {}
            for k, v in row.items():
                if k is None:
                    continue
                key = KO_HEADER.get(k.strip(), k.strip())
                if key in SLOT_IDS:
                    norm[key] = (v or '').strip()
            picked = {s: norm.get(s, 'unknown') for s in DEFENSE_SLOTS}
            # 허용 밖이면 unknown 처리 — 오타 한 칸 때문에 스크립트가 죽지 않게
            for s, v in picked.items():
                if v not in ALLOWED[s]:
                    picked[s] = 'unknown'
            if any(v == 'unknown' for v in picked.values()):
                skipped += 1        # 방어높이를 못 구하는 가구
            rows.append(picked)
    return rows, skipped


def main():
    combos = all_combos()
    n = len(combos)

    print('=' * 72)
    print('개구부 방어높이 격자 — 경로 A 판정이 뒤집히는 지점')
    print('=' * 72)
    print(f'가능한 조합: {n}가지  '
          f'(현관턱 {len(real_values("entrance_sill"))} × 물막이판 {len(real_values("water_panel"))}'
          f' × 창문하단 {len(real_values("window_base"))} × 차수막 {len(real_values("window_barrier"))})')
    print()

    dist = Counter(c[1] for c in combos)
    print('실효 방어높이(cm)별 조합 수 — 판정이 바뀌는 문턱은 이 값들뿐이다')
    print('-' * 72)
    cum = 0
    for v in sorted(dist):
        cum += dist[v]
        print(f'  {v:>4}cm   조합 {dist[v]:>2}개   누적 {cum:>2}/{n}  ({cum / n * 100:>5.1f}%)')
    print('-' * 72)
    print()

    print('침수심별 "유입가능" 비율 — SEG_DEPTH_CM 이 확정되면 해당 행을 읽는다')
    print('-' * 72)
    prev = None
    for d in range(0, 61, 1):
        hit = sum(1 for c in combos if d > c[1])
        if prev is None or hit != prev:
            print(f'  침수심 {d:>2}cm 이상 → 유입가능 {hit:>2}/{n} ({hit / n * 100:>5.1f}%)')
            prev = hit
    print('-' * 72)
    print()

    lo = sum(1 for c in combos if TRACE_MIN_CM > c[1])
    hi = sum(1 for c in combos if TRACE_MAX_CM > c[1])
    print(f'안양 실측 침수심 범위 {TRACE_MIN_CM}~{TRACE_MAX_CM}cm (침수흔적도 8건, 2022년 8월)')
    print(f'  → 가능한 조합의 {lo / n * 100:.1f}~{hi / n * 100:.1f}% 가 유입가능')
    print()

    zeros = [c for c in combos if c[1] == 0]
    no_panel = [c for c in zeros if c[0]['entrance_sill'] == '없음' and c[0]['water_panel'] == '미설치']
    print(f'방어높이 0cm — 어떤 비에도 즉시 유입되는 조합 {len(zeros)}개')
    print(f'  이 중 "현관 턱 없음 + 물막이판 미설치" 가 {len(no_panel)}개')
    print('  현관이 뚫려 있으면 창문을 아무리 높여도 실효 방어높이는 0이다.')
    print('  → 현관 물막이판이 단일 설비로는 효과가 가장 크다. 다만 안양시 미지원 품목이다.')
    print()

    # ── 현장조사 데이터가 있으면 가중 계산 ───────────────────────────
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'field_survey_45.csv')
    if not os.path.exists(path):
        print('=' * 72)
        print(f'현장조사 CSV 없음 ({os.path.basename(path)}) — 조합 전수 기준까지만 계산했습니다.')
        print('위 비율은 "가능한 조합 중" 비율이지 "안양 반지하 중" 비율이 아닙니다.')
        print('CSV 가 들어오면 같은 명령을 다시 실행하면 실측 가중 결과가 함께 나옵니다.')
        print('=' * 72)
        return

    rows, unknown_rows = load_survey(path)
    usable = [r for r in rows if all(v != 'unknown' for v in r.values())]
    print('=' * 72)
    print(f'현장조사 실측 가중  ({os.path.basename(path)})')
    print('=' * 72)
    print(f'전체 {len(rows)}가구 · 방어높이 산출 가능 {len(usable)}가구 · '
          f'네 슬롯 중 unknown 포함 {unknown_rows}가구')
    if not usable:
        print('방어높이를 계산할 수 있는 가구가 없습니다.')
        return

    eff = []
    for r in usable:
        eff.append(diagnose(dict(r), None, None)['surface']['effective_defense_cm'])
    eff.sort()
    mid = eff[len(eff) // 2] if len(eff) % 2 else (eff[len(eff) // 2 - 1] + eff[len(eff) // 2]) / 2
    print(f'실효 방어높이  최소 {min(eff)}cm · 중앙값 {mid}cm · 최대 {max(eff)}cm · 평균 {sum(eff) / len(eff):.1f}cm')
    print()
    wdist = Counter(eff)
    print('방어높이별 가구 수')
    print('-' * 72)
    cum = 0
    for v in sorted(wdist):
        cum += wdist[v]
        print(f'  {v:>4}cm   {wdist[v]:>2}가구   누적 {cum:>2}/{len(eff)}  ({cum / len(eff) * 100:>5.1f}%)')
    print('-' * 72)
    print()
    print('침수심별 유입가능 가구 비율 (실측 가중)')
    print('-' * 72)
    prev = None
    for d in range(0, 61):
        hit = sum(1 for e in eff if d > e)
        if prev is None or hit != prev:
            print(f'  침수심 {d:>2}cm 이상 → {hit:>2}/{len(eff)}가구 ({hit / len(eff) * 100:>5.1f}%)')
            prev = hit
    print('-' * 72)
    lo = sum(1 for e in eff if TRACE_MIN_CM > e)
    hi = sum(1 for e in eff if TRACE_MAX_CM > e)
    print()
    print(f'▶ 안양 실측 침수심 {TRACE_MIN_CM}~{TRACE_MAX_CM}cm 에서')
    print(f'  조사 {len(eff)}가구 중 {lo}~{hi}가구 ({lo / len(eff) * 100:.1f}~{hi / len(eff) * 100:.1f}%) 가 지표 유입 가능')
    print()
    print('  ※ 이 문장이 사업계획서에 쓸 수 있는 형태입니다. 침수심과 방어높이 두 축이')
    print('     모두 안양시 실측이라 도시침수지도 등급 환산값에 의존하지 않습니다.')
    print('=' * 72)


if __name__ == '__main__':
    main()
