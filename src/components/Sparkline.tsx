import { useMemo } from 'react';

export function Sparkline({
  data,
  width = 64,
  height = 22,
  color,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const path = useMemo(() => {
    if (data.length < 2) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const v of data) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max - min || 1;
    const step = width / (data.length - 1);
    let d = '';
    data.forEach((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / span) * (height - 2) - 1;
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { d, rising: data[data.length - 1] >= data[0] };
  }, [data, width, height]);

  if (!path) return <svg width={width} height={height} />;

  const stroke = color ?? (path.rising ? 'var(--color-up)' : 'var(--color-down)');
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <path d={path.d} fill="none" stroke={stroke} strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
