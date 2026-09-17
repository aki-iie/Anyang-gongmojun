import { useState, useMemo } from 'react';
import { css } from './css';

/* 12문항 — admin.js 의 SLOT_COLUMNS 과 동일 순서 */
const SLOT_COLUMNS = [
  { id: 'entrance_sill',   label: '현관 턱' },
  { id: 'stair_count',     label: '계단 수' },
  { id: 'water_panel',     label: '물막이판' },
  { id: 'window_base',     label: '창문 높이' },
  { id: 'window_barrier',  label: '차수막' },
  { id: 'backflow_valve',  label: '역류방지' },
  { id: 'rainy_symptom',   label: '우천증상' },
  { id: 'gurgling',        label: '꿀럭소리' },
  { id: 'floor_backup',    label: '바닥역류' },
  { id: 'road_slope',      label: '골목경사' },
  { id: 'drain_status',    label: '빗물받이' },
  { id: 'canopy',          label: '차양' },
] as const;

type FloodStatus = 'unconfirmed' | 'flooded' | 'safe';

type AdminData = Record<string, string | number> & {
  id: string;
  ticket: string;
  dong: string;
  address: string;
  actualFlooded: FloodStatus;
  floodNote?: string;
  createdAt: string;
};

const TH = css('padding:10px 12px;font-weight:600;color:var(--color-neutral-700);white-space:nowrap');
const TD = css('padding:10px 12px;white-space:nowrap');

export default function Admin() {
  const [password, setPassword] = useState('');
  const [data, setData] = useState<AdminData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/export?format=json&password=${encodeURIComponent(password)}`);
      if (res.status === 401) {
        setError('비밀번호가 일치하지 않습니다.');
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error('서버 오류');
      const json = await res.json();
      setData(json);
    } catch {
      setError('데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const downloadCsv = () => {
    window.location.href = `/api/admin/export?format=csv&password=${encodeURIComponent(password)}`;
  };

  const handleStatusChange = async (id: string, newStatus: FloodStatus) => {
    setUpdatingId(id);
    try {
      const res = await fetch('/api/admin/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          id,
          actualFlooded: newStatus,
        }),
      });
      if (!res.ok) throw new Error('업데이트 실패');
      setData(prev => prev ? prev.map(item => item.id === id ? { ...item, actualFlooded: newStatus } : item) : prev);
    } catch {
      alert('침수 여부 상태 변경에 실패했습니다.');
    } finally {
      setUpdatingId(null);
    }
  };

  const filteredData = useMemo(() => {
    if (!data) return null;
    return data.filter(row => {
      for (const [key, value] of Object.entries(filters)) {
        if (!value) continue;
        if (key === 'ticket') {
          if (!row.ticket.toLowerCase().includes(value.toLowerCase())) return false;
        } else {
          const rowValue = key === 'actualFlooded' ? (row.actualFlooded || 'unconfirmed') : String(row[key] || '');
          if (rowValue !== value) return false;
        }
      }
      return true;
    });
  }, [data, filters]);

  const uniqueOptions = useMemo(() => {
    if (!data) return {} as Record<string, string[]>;
    const options: Record<string, string[]> = {};
    const keys = ['dong', 'actualFlooded', ...SLOT_COLUMNS.map(c => c.id)];
    for (const key of keys) {
      const set = new Set<string>();
      for (const row of data) {
        const val = key === 'actualFlooded' ? (row.actualFlooded || 'unconfirmed') : String(row[key] || '');
        if (val) set.add(val);
      }
      options[key] = Array.from(set).sort();
    }
    return options;
  }, [data]);

  const stats = useMemo(() => {
    const target = filteredData || data;
    if (!target) return { total: 0, flooded: 0, safe: 0, unconfirmed: 0 };
    return {
      total: target.length,
      flooded: target.filter(d => d.actualFlooded === 'flooded').length,
      safe: target.filter(d => d.actualFlooded === 'safe').length,
      unconfirmed: target.filter(d => !d.actualFlooded || d.actualFlooded === 'unconfirmed').length,
    };
  }, [filteredData, data]);

  const renderFilterSelect = (key: string) => {
    const options = uniqueOptions[key] || [];
    if (options.length === 0) return null;
    const isActive = !!filters[key];
    
    const getDisplay = (val: string) => {
      if (key === 'actualFlooded') {
        if (val === 'flooded') return '🚨 침수 발생';
        if (val === 'safe') return '🟢 이상 없음';
        if (val === 'unconfirmed') return '미확인';
      }
      return val;
    };

    return (
      <select
        value={filters[key] || ''}
        onChange={e => setFilters(prev => ({ ...prev, [key]: e.target.value }))}
        style={css(`margin-top:6px;width:100%;padding:4px;border-radius:4px;font-size:11px;font-weight:500;border:1px solid ${isActive ? 'var(--color-accent)' : 'var(--color-neutral-300)'};background:${isActive ? 'var(--color-accent-50)' : '#fff'};color:${isActive ? 'var(--color-accent-700)' : 'var(--color-neutral-700)'};outline:none;cursor:pointer`)}
      >
        <option value="">(전체)</option>
        {options.map(opt => (
          <option key={opt} value={opt}>{getDisplay(opt)}</option>
        ))}
      </select>
    );
  };

  if (data === null) {
    return (
      <section style={css('display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:50vh;gap:20px;padding:20px')}>
        <h2 style={css('font-size:24px;margin:0')}>관리자 로그인</h2>
        <form onSubmit={handleLogin} style={css('display:flex;flex-direction:column;gap:12px;width:100%;max-width:320px')}>
          <input 
            type="password" 
            placeholder="비밀번호" 
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
            lang="en"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="current-password"
            style={css('padding:12px;border-radius:8px;border:1px solid var(--color-neutral-200);font-size:16px;ime-mode:disabled')}
          />
          <button type="submit" disabled={loading} className="btn btn-primary" style={css('padding:12px;border-radius:8px;font-size:16px;font-weight:600')}>
            {loading ? '확인 중...' : '확인'}
          </button>
          {error && <p style={css('color:var(--color-accent-700);font-size:14px;margin:0;text-align:center')}>{error}</p>}
        </form>
      </section>
    );
  }

  return (
    <section style={css('display:flex;flex-direction:column;gap:20px;padding-top:20px')}>
      <div style={css('display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px')}>
        <div>
          <h2 style={css('font-size:24px;margin:0;letter-spacing:-0.02em')}>문진 응답 및 침수 실증 데이터</h2>
          <div style={css('display:flex;gap:12px;align-items:center;margin-top:6px;flex-wrap:wrap')}>
            <p style={css('font-size:14px;color:var(--color-neutral-600);margin:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap')}>
              <span>총 {stats.total}건</span>
              <span>·</span>
              <span style={{ color: '#dc2626', fontWeight: 600 }}>침수 확인 {stats.flooded}건</span>
              <span>·</span>
              <span style={{ color: '#16a34a', fontWeight: 600 }}>이상 없음 {stats.safe}건</span>
              <span>·</span>
              <span style={{ color: 'var(--color-neutral-500)' }}>미확인 {stats.unconfirmed}건</span>
            </p>
            {Object.values(filters).some(v => v) && (
              <button 
                onClick={() => setFilters({})}
                style={css('padding:4px 8px;font-size:11px;background:var(--color-neutral-200);color:var(--color-neutral-700);border:none;border-radius:4px;cursor:pointer;font-weight:600;display:inline-flex;align-items:center;gap:4px')}
              >
                <span>초기화</span><span>↺</span>
              </button>
            )}
          </div>
        </div>
        <button onClick={downloadCsv} className="btn btn-primary" style={css('padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600')}>
          📥 CSV 다운로드
        </button>
      </div>

      <div style={css('overflow-x:auto;border-radius:8px;border:1px solid var(--color-neutral-200);background:var(--color-surface)')}>
        <table style={css('width:100%;border-collapse:collapse;text-align:left;font-size:13px')}>
          <thead style={css('background:var(--color-neutral-100);border-bottom:1px solid var(--color-neutral-200);vertical-align:top')}>
            <tr>
              <th style={TH}>
                <div style={css('display:flex;flex-direction:column;gap:4px')}>
                  <span>접수번호</span>
                  <input 
                    type="text" 
                    placeholder="검색..." 
                    value={filters.ticket || ''}
                    onChange={e => setFilters(prev => ({ ...prev, ticket: e.target.value }))}
                    style={css(`margin-top:2px;width:100%;padding:4px;border-radius:4px;font-size:11px;border:1px solid ${filters.ticket ? 'var(--color-accent)' : 'var(--color-neutral-300)'};background:${filters.ticket ? 'var(--color-accent-50)' : '#fff'};outline:none;box-sizing:border-box`)}
                  />
                </div>
              </th>
              <th style={TH}>
                <div style={css('display:flex;flex-direction:column')}>
                  <span>실제 침수 여부</span>
                  {renderFilterSelect('actualFlooded')}
                </div>
              </th>
              <th style={TH}>
                <div style={css('display:flex;flex-direction:column')}>
                  <span>동</span>
                  {renderFilterSelect('dong')}
                </div>
              </th>
              <th style={TH}>
                <div style={css('display:flex;flex-direction:column;justify-content:space-between;height:100%')}>
                  <span>주소 (좌우 스크롤 가능)</span>
                </div>
              </th>
              <th style={TH}>
                <div style={css('display:flex;flex-direction:column;justify-content:space-between;height:100%')}>
                  <span>접수일시</span>
                </div>
              </th>
              {SLOT_COLUMNS.map(c => (
                <th key={c.id} style={TH}>
                  <div style={css('display:flex;flex-direction:column')}>
                    <span>{c.label}</span>
                    {renderFilterSelect(c.id)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredData?.map((d, i) => {
              const status = d.actualFlooded || 'unconfirmed';
              return (
                <tr key={d.id} style={{ borderBottom: i < data.length - 1 ? '1px solid var(--color-neutral-200)' : 'none' }}>
                  <td style={css('padding:10px 12px;font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap')}>{d.ticket}</td>
                  <td style={TD}>
                    <select
                      value={status}
                      disabled={updatingId === d.id}
                      onChange={(e) => handleStatusChange(d.id, e.target.value as FloodStatus)}
                      style={css(
                        'padding:4px 8px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;outline:none;transition:all 0.15s ease;' +
                        (status === 'flooded' 
                          ? 'background:#fee2e2;color:#b91c1c;border:1px solid #f87171;' 
                          : status === 'safe'
                          ? 'background:#dcfce7;color:#15803d;border:1px solid #86efac;'
                          : 'background:var(--color-neutral-100);color:var(--color-neutral-700);border:1px solid var(--color-neutral-300);')
                      )}
                    >
                      <option value="unconfirmed">미확인</option>
                      <option value="flooded">🚨 침수 발생</option>
                      <option value="safe">🟢 이상 없음</option>
                    </select>
                    {updatingId === d.id && (
                      <span style={css('margin-left:6px;font-size:11px;color:var(--color-neutral-500)')}>저장중…</span>
                    )}
                  </td>
                  <td style={TD}>{d.dong}</td>
                  <td style={css('padding:8px 12px;max-width:240px;min-width:180px;white-space:nowrap')}>
                    <div 
                      style={css('max-width:240px;overflow-x:auto;white-space:nowrap;scrollbar-width:thin;padding-bottom:2px')}
                      title={d.address}
                    >
                      {d.address}
                    </div>
                  </td>
                  <td style={css('padding:10px 12px;color:var(--color-neutral-600);white-space:nowrap')}>{d.createdAt}</td>
                  {SLOT_COLUMNS.map(c => (
                    <td key={c.id} style={TD}>{String(d[c.id] || '')}</td>
                  ))}
                </tr>
              );
            })}
            {filteredData && filteredData.length === 0 && (
              <tr>
                <td colSpan={5 + SLOT_COLUMNS.length} style={css('padding:32px;text-align:center;color:var(--color-neutral-600)')}>조건에 맞는 내역이 없습니다.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

