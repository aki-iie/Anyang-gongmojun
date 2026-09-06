/* CSS 문자열을 React style 객체로 바꿔주는 helper.
   디자인 시안의 인라인 스타일을 그대로 옮기기 위해 씁니다.
   예: style={css('font-size:20px;color:var(--color-accent)')} */
import type { CSSProperties } from 'react';

const cache = new Map<string, CSSProperties>();

export function css(str: string): CSSProperties {
  const hit = cache.get(str);
  if (hit) return hit;
  const obj: Record<string, string> = {};
  for (const decl of str.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (!prop || !value) continue;
    const key = prop.startsWith('--')
      ? prop
      : prop.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
    obj[key] = value;
  }
  const style = obj as CSSProperties;
  cache.set(str, style);
  return style;
}
