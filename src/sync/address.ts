/* 주소 입력 = 두 단계
   ① 다음(카카오) 우편번호 서비스로 정확한 주소를 고르게 한다 — 키가 필요 없다
   ② 고른 주소를 VWorld 지오코더(/api/geocode)로 좌표로 바꾼다 */

const POSTCODE_SRC = 'https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';

/* 다음 우편번호 서비스가 넘겨주는 값 중 우리가 쓰는 것만 추린 타입 */
type PostcodeData = {
  roadAddress?: string; address?: string;
  jibunAddress?: string; autoJibunAddress?: string;
  zonecode?: string;
};
type PostcodeOptions = {
  oncomplete?: (data: PostcodeData) => void;
  onresize?: (size: { width: number; height: number }) => void;
  width?: string; height?: string;
};
type PostcodeInstance = { embed: (el: HTMLElement, opt?: { autoClose?: boolean }) => void; open: () => void };

declare global {
  interface Window {
    daum?: { Postcode: new (opt: PostcodeOptions) => PostcodeInstance };
  }
}

let loading: Promise<void> | null = null;

/** 우편번호 스크립트를 필요할 때만 불러온다 */
export function loadPostcode(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('브라우저가 아닙니다.'));
  if (window.daum?.Postcode) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = POSTCODE_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { loading = null; reject(new Error('주소 검색을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')); };
    document.head.appendChild(el);
  });
  return loading;
}

export type PickedAddress = {
  road: string;        // 도로명주소
  jibun: string;       // 지번주소
  zonecode: string;    // 우편번호
};

/** 주소 검색창을 화면 안에 띄운다.
    새 창(open)은 모바일에서 팝업 차단에 걸리므로 오버레이에 embed 한다. */
export function searchAddress(): Promise<PickedAddress | null> {
  return loadPostcode().then(
    () =>
      new Promise<PickedAddress | null>((resolve) => {
        const back = document.createElement('div');
        back.style.cssText =
          'position:fixed;inset:0;z-index:1000;background:rgba(36,35,31,.5);' +
          'display:flex;flex-direction:column;justify-content:flex-end';

        const sheet = document.createElement('div');
        sheet.style.cssText =
          'background:var(--color-bg);border-radius:16px 16px 0 0;overflow:hidden;' +
          'height:min(560px,86vh);display:flex;flex-direction:column;box-shadow:0 -8px 30px rgba(0,0,0,.25)';

        const bar = document.createElement('div');
        bar.style.cssText =
          'display:flex;align-items:center;justify-content:space-between;gap:12px;' +
          'padding:14px 16px;border-bottom:1px solid var(--color-neutral-200);flex:none';
        const title = document.createElement('strong');
        title.textContent = '주소 검색';
        title.style.cssText = 'font-size:17px;font-family:inherit';
        const close = document.createElement('button');
        close.textContent = '닫기';
        close.style.cssText =
          'font:inherit;font-size:15px;border:1px solid var(--color-neutral-200);background:var(--color-bg);' +
          'color:var(--color-text);border-radius:8px;padding:7px 14px;cursor:pointer';
        bar.append(title, close);

        const box = document.createElement('div');
        box.style.cssText = 'flex:1;min-height:0';

        sheet.append(bar, box);
        back.appendChild(sheet);
        document.body.appendChild(back);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        let settled = false;
        const finish = (v: PickedAddress | null) => {
          if (settled) return;
          settled = true;
          document.body.style.overflow = prevOverflow;
          back.remove();
          resolve(v);
        };
        close.onclick = () => finish(null);
        back.onclick = (e) => { if (e.target === back) finish(null); };

        new window.daum!.Postcode({
          oncomplete: (d: PostcodeData) => {
            finish({
              road: d.roadAddress || d.address || '',
              jibun: d.jibunAddress || d.autoJibunAddress || '',
              zonecode: d.zonecode || '',
            });
          },
          onresize: (size: { width: number; height: number }) => { box.style.height = size.height + 'px'; },
          width: '100%',
          height: '100%',
        }).embed(box, { autoClose: false });
      })
  );
}

export type GeocodeResult = { found: boolean; lat?: number; lon?: number; refined?: string; matched?: string };

/** 주소 문자열을 좌표로 바꾼다 */
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  try {
    const res = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`);
    if (!res.ok) { console.error('[Geocode] 실패', res.status, await res.text()); return null; }
    const d = (await res.json()) as GeocodeResult;
    console.log('[Geocode]', d);
    return d;
  } catch (err) {
    console.error('[Geocode] 예외', err);
    return null;
  }
}
