#!/usr/bin/env python3
"""검정력 — 라벨이 몇 가구 × 몇 년 쌓여야 "이 컬럼이 중요하다" 고 말할 수 있는가

이 스크립트가 답하는 질문
  우리는 가중치를 정하지 않는다. 라벨이 쌓이면 데이터가 알려 준다 — 는 게 설계다.
  그러면 심사위원이 묻는다. **"그래서 언제 알려주는데요?"**
  그 질문에 숫자로 답하는 게 이 스크립트다.

  답의 형태:
    "연간 침수율 5%, 취약 가구의 위험비가 3배라면
     100가구를 5년 모아도 검출력은 X% 다. N가구 Y년이면 80% 를 넘는다."

  이건 침수에 대한 발견이 아니라 **데이터 수집 계획에 대한 발견**이다.
  우리가 지금 근거를 갖고 말할 수 있는 건 여기까지다.

랜덤 라벨은 왜 결론이 못 되는가
  `--rule none` 으로 돌리면 라벨을 순수 난수로 붙인다. 컬럼과 침수 사이에
  아무 관계가 없다. 그런데도 어떤 컬럼은 중요도 점수가 높게 나온다 — 12개를
  훑으면 그중 하나는 우연히 튀기 때문이다. 그 값이 "중요한 피처" 로 보인다.
  그래서 랜덤 라벨은 **결론이 아니라 귀무분포(대조군)** 로만 써야 한다.
  아래 계산은 실제로 그렇게 쓴다: 순열로 만든 귀무분포의 95퍼센타일을 넘어야
  비로소 "노이즈보다 크다" 고 말한다.

통계
  컬럼마다 (값 × 침수여부) 분할표를 만들고 G검정(우도비 카이제곱)을 쓴다.
  임계값은 라벨을 무작위로 섞어(순열) 12개 컬럼 중 **최댓값** 의 분포를 만든 뒤
  그 95퍼센타일로 잡는다. 12개를 동시에 훑는 데 대한 보정이 여기 들어 있다.
  외부 패키지를 쓰지 않는다 — 표준 라이브러리만으로 돈다.

사용법
  python3 tools/label_power.py                       # 기본 시나리오 한 판
  python3 tools/label_power.py --sweep               # 가구수 × 연수 표
  python3 tools/label_power.py --rule none           # 랜덤 라벨(대조군) 검정력
"""
import argparse
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from label_table import SLOT_IDS, RULES, make_cohort, label_cohort   # noqa: E402


def gstat(codes, labels, k):
    """G검정 통계량. codes 는 0..k-1 정수 배열, labels 는 0/1 배열."""
    n = len(labels)
    cnt = [[0, 0] for _ in range(k)]
    for c, y in zip(codes, labels):
        cnt[c][y] += 1
    tot1 = sum(labels)
    tot0 = n - tot1
    if tot1 == 0 or tot0 == 0:
        return 0.0
    g = 0.0
    for n0, n1 in cnt:
        rt = n0 + n1
        if rt == 0:
            continue
        for obs, ct in ((n0, tot0), (n1, tot1)):
            if obs > 0:
                g += 2 * obs * math.log(obs / (rt * ct / n))
    return g


def encode(rows):
    """행 목록 → 컬럼별 정수 코드. 값이 한 종류뿐인 컬럼은 버린다."""
    cols = {}
    for s in SLOT_IDS:
        vals = sorted({h['slots'][s] for h, _, _ in rows})
        if len(vals) < 2:
            continue
        idx = {v: i for i, v in enumerate(vals)}
        cols[s] = ([idx[h['slots'][s]] for h, _, _ in rows], len(vals))
    return cols


def null_threshold(cols, n_pos, n, perms, rng, q=0.95):
    """라벨을 무작위로 섞어 '12개 중 최대 G' 의 분포를 만든다 → 95퍼센타일."""
    base = [1] * n_pos + [0] * (n - n_pos)
    out = []
    for _ in range(perms):
        rng.shuffle(base)
        out.append(max(gstat(c, base, k) for c, k in cols.values()))
    out.sort()
    return out[min(len(out) - 1, int(q * len(out)))]


def run(n, years, base, rr, rule, sims, perms, seed, verbose=False):
    rng = random.Random(seed)
    cohort = make_cohort(n, rng)

    # 설계 행렬(가구 구성)은 고정하고 라벨만 다시 뽑는다.
    # "N가구를 Y년 관찰했을 때" 가 우리가 답할 질문이므로 이게 맞다.
    rows0 = label_cohort(cohort, years, base, rr, rule, rng)
    cols = encode(rows0)
    total = len(rows0)

    hits, detected_any, pos_total = 0, 0, 0
    thr_cache = {}
    winner = {}
    for _ in range(sims):
        rows = label_cohort(cohort, years, base, rr, rule, rng)
        labels = [lab for _, _, lab in rows]
        n_pos = sum(labels)
        pos_total += n_pos
        if n_pos == 0 or n_pos == total:
            continue
        if n_pos not in thr_cache:
            thr_cache[n_pos] = null_threshold(cols, n_pos, total, perms,
                                              random.Random(seed + n_pos))
        thr = thr_cache[n_pos]
        gs = {s: gstat(c, labels, k) for s, (c, k) in cols.items()}
        top = max(gs, key=gs.get)
        if gs[top] > thr:
            detected_any += 1
            winner[top] = winner.get(top, 0) + 1
        hits += 1

    return {
        'n': n, 'years': years, 'rows': total,
        'mean_pos': pos_total / max(1, sims),
        'power': detected_any / max(1, hits),
        'winner': winner,
    }


def fmt(r):
    return (f'{r["n"]:>4}가구 × {r["years"]}년 = {r["rows"]:>5}행 · '
            f'평균 침수 {r["mean_pos"]:>5.1f}건 · 검출력 {r["power"] * 100:>5.1f}%')


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--n', type=int, default=100)
    ap.add_argument('--years', type=int, default=5)
    ap.add_argument('--base', type=float, default=0.05, help='기준 연간 침수 확률')
    ap.add_argument('--rr', type=float, default=3.0, help='취약 가구 위험비')
    ap.add_argument('--rule', choices=sorted(RULES), default='defense0')
    ap.add_argument('--sims', type=int, default=200)
    ap.add_argument('--perms', type=int, default=300)
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--sweep', action='store_true', help='가구수 × 연수 표')
    a = ap.parse_args()

    print('=' * 74)
    print('라벨 검정력 — 몇 가구 × 몇 년이면 취약 컬럼이 노이즈 위로 올라오는가')
    print('=' * 74)
    print(f'심은 규칙  {a.rule} — {RULES[a.rule][0]}')
    print(f'가정       기준 연간 침수율 {a.base * 100:.0f}% · 취약 가구 위험비 {a.rr}배')
    print(f'검정       12개 컬럼 G검정 · 순열 귀무분포 최댓값의 95퍼센타일을 임계값으로')
    print(f'반복       시뮬레이션 {a.sims}회 × 순열 {a.perms}회')
    print('-' * 74)

    if a.sweep:
        grid = [(50, 3), (100, 3), (100, 5), (200, 5), (500, 5), (500, 10), (1000, 10)]
        for n, y in grid:
            print(fmt(run(n, y, a.base, a.rr, a.rule, a.sims, a.perms, a.seed)))
    else:
        r = run(a.n, a.years, a.base, a.rr, a.rule, a.sims, a.perms, a.seed)
        print(fmt(r))
        if r['winner']:
            print()
            print('임계값을 넘은 컬럼 (횟수)')
            for s, c in sorted(r['winner'].items(), key=lambda x: -x[1]):
                print(f'  {s:<18} {c:>4}회')

    print('-' * 74)
    if a.rule == 'none':
        print('※ 라벨을 난수로 붙였으므로 검출력은 유의수준(5%) 근처여야 정상입니다.')
        print('  랜덤 라벨에서 나오는 "중요한 컬럼" 은 우연이라는 뜻입니다.')
    else:
        print('※ 이 표는 침수에 대한 발견이 아니라 **수집 계획에 대한 발견** 입니다.')
        print('  위험비를 우리가 심었으므로, 읽는 방식은 이렇습니다 —')
        print('  "이 정도 크기의 관계가 실제로 있다면, 이만큼 모아야 보인다."')
    print('=' * 74)


if __name__ == '__main__':
    main()
