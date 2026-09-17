#!/usr/bin/env python3
"""학습 테이블 — 문진 응답을 "나중에 라벨을 붙일 수 있는 컬럼" 으로 고정한다.

왜 만드나
  침수 예측 가중치를 지금 정할 수 없다. 어떤 반지하가 실제로 잠겼는지를
  가구 단위로 기록한 데이터가 국내에 없기 때문이다. 없는 라벨로 가중치를
  만들면 그 숫자는 근거가 아니라 우리 주장이다.

  그래서 이 프로젝트는 가중치를 만들지 않는다. 대신 **라벨이 나중에 붙을
  자리**를 지금 고정한다. 문진 12개 응답을 표준 컬럼으로 저장해 두면, 몇 년
  뒤 호우 피해 기록이 생겼을 때 `flooded` 한 칸만 채우면 된다. 가중치는 그때
  데이터에서 나온다. 우리가 정하는 게 아니다.

  Firestore `stats` 컬렉션이 이미 이 구조다(functions/save.js buildStats).
  진단이 한 건 끝날 때마다 12개 슬롯이 그대로 익명 저장된다. 이 스크립트는
  그 덤프를 학습 테이블 CSV 로 펴는 일과, 아직 라벨이 없는 동안 파이프라인을
  돌려 보기 위한 더미 생성을 담당한다.

테이블 한 행 = 가구 하나 × 연도 하나
  house_id, year                     식별 (가구는 여러 해 반복 등장)
  dong, grid_id                      집계 단위
  <12개 문진 슬롯>                   입력 (scripts/diagnose.py ALLOWED 그대로)
  effective_defense_cm, weakest_point,
  surface_status, backflow_status    엔진 파생값 — 재계산 가능, 읽기 편하라고 같이 둔다
  depth_cm                           그 지점 예상 침수심 (있으면)
  flooded                            ★ 라벨. 1/0. 지금은 전부 빈칸이다.
  label_source                       라벨 출처 (피해신고 / 현장확인 / …) — 빈칸
  label_note                         비고 — 빈칸

  ⚠ flooded / label_source / label_note 세 칸은 **우리가 채우지 않는다.**
    호우 피해 기록을 가진 기관만 채울 수 있다. 빈칸으로 두는 게 설계다.

사용법
  python3 tools/label_table.py schema                     # 헤더만 출력 (빈 테이블)
  python3 tools/label_table.py export stats.json > t.csv  # Firestore 덤프 → CSV
  python3 tools/label_table.py dummy --n 100 --years 5 > dummy.csv
"""
import argparse
import csv
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

try:
    from diagnose import diagnose, ALLOWED, SLOT_IDS      # noqa: E402
except ImportError as e:                                   # pragma: no cover
    sys.exit(f'scripts/diagnose.py 를 불러오지 못했습니다: {e}')

ID_COLS = ['house_id', 'year', 'dong', 'grid_id']
DERIVED_COLS = ['effective_defense_cm', 'weakest_point',
                'surface_status', 'backflow_status', 'depth_cm']
LABEL_COLS = ['flooded', 'label_source', 'label_note']
HEADER = ID_COLS + list(SLOT_IDS) + DERIVED_COLS + LABEL_COLS


def real_values(slot):
    """unknown 을 뺀 실제 선택지"""
    return [v for v in ALLOWED[slot] if v != 'unknown']


def derive(slots, depth_cm=None):
    """엔진을 그대로 돌려 파생 컬럼을 채운다. 값을 여기서 다시 쓰지 않는다."""
    r = diagnose(dict(slots), depth_cm, None)
    s, b = r['surface'], r['backflow']
    return {
        'effective_defense_cm': s.get('effective_defense_cm'),
        'weakest_point': s.get('weakest_point'),
        'surface_status': s.get('status'),
        'backflow_status': b.get('status'),
        'depth_cm': depth_cm,
    }


def blank_row():
    return {c: '' for c in HEADER}


# ── export: Firestore stats 덤프 → 학습 테이블 ──────────────────────────
def cmd_export(args):
    """stats 덤프(JSON 배열 또는 JSON Lines) → CSV.

    라벨 칸은 비운다. 관측 연도는 문서의 createdAt 연도를 쓴다.
    """
    raw = open(args.path, encoding='utf-8').read().strip()
    docs = json.loads(raw) if raw.startswith('[') else [json.loads(l) for l in raw.splitlines() if l.strip()]

    w = csv.DictWriter(sys.stdout, fieldnames=HEADER)
    w.writeheader()
    for i, d in enumerate(docs, 1):
        row = blank_row()
        row['house_id'] = d.get('id') or f'S{i:05d}'
        row['year'] = (str(d.get('createdAt') or '')[:4]) or ''
        row['dong'] = d.get('dong') or ''
        row['grid_id'] = (d.get('grid') or {}).get('id') or ''
        for s in SLOT_IDS:
            row[s] = (d.get('slots') or {}).get(s, 'unknown')
        row['effective_defense_cm'] = d.get('defenseCm', '')
        row['weakest_point'] = d.get('weakestPoint') or ''
        row['surface_status'] = d.get('surface') or ''
        row['backflow_status'] = d.get('backflow') or ''
        row['depth_cm'] = d.get('depthCm', '')
        w.writerow(row)
    print(f'{len(docs)}행 · 라벨 칸 {len(LABEL_COLS)}개는 비워 두었습니다.', file=sys.stderr)


# ── dummy: 라벨이 없는 동안 파이프라인을 돌려 보기 위한 가짜 코호트 ────────
#
#   ⚠ 이 데이터로 "어떤 컬럼이 침수에 중요하다" 를 말할 수 없다.
#     여기서 나오는 중요도는 아래 --rule 로 우리가 직접 심은 규칙일 뿐이다.
#     쓰임새는 두 가지뿐이다.
#       (1) 분석 파이프라인이 끝까지 도는지 보는 시연
#       (2) "라벨이 몇 가구 × 몇 년 쌓여야 이 규칙이 잡히는가" 검정력 계산
#     (2) 가 tools/label_power.py 다.

RULES = {
    # 이름: (설명, 가구 slots → 취약 여부)
    'defense0': ('실효 방어높이 0cm (현관이 뚫려 있음)',
                 lambda s, d: (d['effective_defense_cm'] or 0) == 0),
    'nopanel': ('현관 턱 없음 + 물막이판 미설치',
                lambda s, d: s['entrance_sill'] == '없음' and s['water_panel'] == '미설치'),
    'backflow': ('역류 대비 미흡 (차수판으로 못 막는 유형)',
                 lambda s, d: d['backflow_status'] in ('미흡', '매우미흡')),
    'none': ('없음 — 라벨을 순수 난수로 붙인다 (귀무 대조군)',
             lambda s, d: False),
}


def make_cohort(n, rng, depth_cm=None):
    """가구 n개. 각 슬롯을 선택지에서 균등 추출한다(unknown 제외)."""
    out = []
    for i in range(n):
        slots = {s: rng.choice(real_values(s)) for s in SLOT_IDS}
        out.append({'house_id': f'H{i + 1:04d}', 'slots': slots,
                    'derived': derive(slots, depth_cm)})
    return out


def label_cohort(cohort, years, base, rr, rule, rng):
    """가구 × 연도마다 침수 여부를 뽑는다. 취약 가구는 확률이 rr 배."""
    is_vuln = RULES[rule][1]
    rows = []
    for h in cohort:
        v = is_vuln(h['slots'], h['derived'])
        p = min(1.0, base * (rr if v else 1.0))
        for y in range(years):
            rows.append((h, y, 1 if rng.random() < p else 0))
    return rows


def cmd_dummy(args):
    rng = random.Random(args.seed)
    cohort = make_cohort(args.n, rng, args.depth)
    rows = label_cohort(cohort, args.years, args.base, args.rr, args.rule, rng)

    w = csv.DictWriter(sys.stdout, fieldnames=HEADER)
    w.writeheader()
    hits = 0
    for h, y, lab in rows:
        row = blank_row()
        row['house_id'] = h['house_id']
        row['year'] = args.year0 + y
        row['dong'] = '(더미)'
        for s in SLOT_IDS:
            row[s] = h['slots'][s]
        for k, v in h['derived'].items():
            row[k] = '' if v is None else v
        row['flooded'] = lab
        row['label_source'] = '더미'
        row['label_note'] = f'rule={args.rule} rr={args.rr} base={args.base}'
        hits += lab
        w.writerow(row)

    print(f'더미 {args.n}가구 × {args.years}년 = {len(rows)}행 · 침수 {hits}건 '
          f'({hits / len(rows) * 100:.1f}%)', file=sys.stderr)
    print(f'심은 규칙: {args.rule} — {RULES[args.rule][0]} (위험비 {args.rr}배)', file=sys.stderr)
    print('⚠ 이 파일로 "어떤 컬럼이 중요하다" 를 주장하면 안 됩니다. '
          '위 규칙을 우리가 직접 심었기 때문입니다.', file=sys.stderr)


def cmd_schema(args):
    w = csv.writer(sys.stdout)
    w.writerow(HEADER)
    print(f'컬럼 {len(HEADER)}개 — 식별 {len(ID_COLS)} · 문진 {len(SLOT_IDS)} · '
          f'파생 {len(DERIVED_COLS)} · 라벨 {len(LABEL_COLS)}(빈칸)', file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest='cmd', required=True)

    sub.add_parser('schema', help='헤더만 출력').set_defaults(fn=cmd_schema)

    e = sub.add_parser('export', help='Firestore stats 덤프 → 학습 테이블 CSV')
    e.add_argument('path')
    e.set_defaults(fn=cmd_export)

    d = sub.add_parser('dummy', help='더미 코호트 생성 (파이프라인 시연 전용)')
    d.add_argument('--n', type=int, default=100, help='가구 수')
    d.add_argument('--years', type=int, default=5, help='관측 연수')
    d.add_argument('--year0', type=int, default=2026)
    d.add_argument('--base', type=float, default=0.05, help='기준 연간 침수 확률')
    d.add_argument('--rr', type=float, default=3.0, help='취약 가구 위험비')
    d.add_argument('--rule', choices=sorted(RULES), default='defense0')
    d.add_argument('--depth', type=float, default=None, help='예상 침수심 cm')
    d.add_argument('--seed', type=int, default=42)
    d.set_defaults(fn=cmd_dummy)

    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
