import { useEffect, useRef } from 'react';

/* 화면 하단에 빗방울이 바닥에 떨어지는 효과.
   drops = 떨어지는 빗줄기, ripples = 바닥에 퍼지는 물결, bits = 튀는 물방울. */
type Drop = { x: number; y: number; len: number; v: number; fy: number };
type Ripple = { x: number; y: number; r: number; a: number; k: number };
type Bit = { x: number; y: number; vx: number; vy: number; a: number };

export default function RainCanvas({ enabled = true, height = 260 }: { enabled?: boolean; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, raf = 0;

    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      W = c.clientWidth; H = c.clientHeight;
      c.width = W * dpr; c.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const ink = (a: number) => `rgba(86,127,99,${a})`;
    const drops: Drop[] = [], ripples: Ripple[] = [], bits: Bit[] = [];
    const spawn = (d: Partial<Drop>): Drop => {
      d.x = Math.random() * W;
      d.y = -Math.random() * H * 1.5;
      d.len = 14 + Math.random() * 20;
      d.v = 5 + Math.random() * 3;
      d.fy = H * 0.7 + Math.random() * (H * 0.3 - 12);
      return d as Drop;
    };
    for (let i = 0; i < 36; i++) drops.push(spawn({}));

    let last = performance.now();
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((t - last) / 16.7, 3); last = t;
      ctx.clearRect(0, 0, W, H);
      if (!enabled || reduce) return;

      const fy = H * 0.7;
      const g = ctx.createLinearGradient(0, fy - 40, 0, H);
      g.addColorStop(0, ink(0)); g.addColorStop(1, ink(0.12));
      ctx.fillStyle = g; ctx.fillRect(0, fy - 40, W, H - fy + 40);

      ctx.lineCap = 'round'; ctx.lineWidth = 1.3; ctx.strokeStyle = ink(0.32);
      for (const d of drops) {
        d.y += d.v * dt;
        ctx.beginPath(); ctx.moveTo(d.x, d.y - d.len); ctx.lineTo(d.x, d.y); ctx.stroke();
        if (d.y >= d.fy) {
          ripples.push({ x: d.x, y: d.fy, r: 2, a: 0.5, k: 0.28 });
          for (let i = 0; i < 3; i++) {
            bits.push({ x: d.x, y: d.fy, vx: (Math.random() - 0.5) * 2.4, vy: -(1.5 + Math.random() * 2), a: 0.6 });
          }
          spawn(d);
        }
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i]; r.r += 0.7 * dt; r.a -= 0.011 * dt;
        if (r.a <= 0) { ripples.splice(i, 1); continue; }
        ctx.strokeStyle = ink(r.a); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r, r.r * r.k, 0, 0, Math.PI * 2); ctx.stroke();
      }
      for (let i = bits.length - 1; i >= 0; i--) {
        const b = bits[i]; b.x += b.vx * dt; b.y += b.vy * dt; b.vy += 0.18 * dt; b.a -= 0.03 * dt;
        if (b.a <= 0) { bits.splice(i, 1); continue; }
        ctx.fillStyle = ink(b.a); ctx.beginPath(); ctx.arc(b.x, b.y, 1.1, 0, Math.PI * 2); ctx.fill();
      }
    };
    raf = requestAnimationFrame(loop);

    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [enabled]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ position: 'fixed', left: 0, right: 0, bottom: 0, width: '100%', height, pointerEvents: 'none', zIndex: 0 }}
    />
  );
}
