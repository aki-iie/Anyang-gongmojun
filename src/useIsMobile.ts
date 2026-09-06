import { useEffect, useState } from 'react';

/* 768px 이하를 모바일로 본다. 데스크톱 레이아웃은 그대로 두고,
   이 값이 true 일 때만 "카메라 퍼스트" 모바일 구성이 켜진다. */
const QUERY = '(max-width: 768px)';

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(QUERY).matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
