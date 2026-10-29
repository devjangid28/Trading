import { useEffect, useMemo, useState } from 'react';

interface BridgePoint {
  x: number;
  y: number;
}

interface BridgePath {
  from: BridgePoint;
  to: BridgePoint;
  color: string;
  label?: string;
}

interface Props {
  bridges: BridgePath[];
  containerRef: React.RefObject<SVGSVGElement | null>;
  className?: string;
}

export function BridgeConnector({ bridges, containerRef, className = '' }: Props) {
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      setSvgSize({ width: rect.width, height: rect.height });
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const paths = useMemo(
    () =>
      bridges.map((b) => {
        const fromX = b.from.x;
        const fromY = b.from.y;
        const toX = b.to.x;
        const toY = b.to.y;

        const midX = (fromX + toX) / 2;
        const cp1x = fromX;
        const cp1y = fromY + (toY - fromY) * 0.3;
        const cp2x = toX;
        const cp2y = toY - (toY - fromY) * 0.3;

        return (
          <g key={`${fromX}-${fromY}-${toX}-${toY}`}>
            <path
              d={`M${fromX} ${fromY} C${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${toX} ${toY}`}
              stroke={b.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray="6 4"
              fill="none"
              opacity={0.6}
              filter="url(#bridgeGlow)"
            />
            {b.label && (
              <text
                x={midX}
                y={(fromY + toY) / 2 - 6}
                textAnchor="middle"
                fontSize={9}
                fill={b.color}
                className="mono"
                style={{ fontWeight: 600, textShadow: '0 0 4px var(--bg)' }}
              >
                {b.label}
              </text>
            )}
          </g>
        );
      }),
    [bridges, svgSize],
  );

  if (svgSize.width === 0 || svgSize.height === 0) {
    return (
      <svg
        ref={containerRef as React.RefObject<SVGSVGElement>}
        className={`bridge-svg ${className}`}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}
        width={0}
        height={0}
      />
    );
  }

  return (
    <svg
      ref={containerRef as React.RefObject<SVGSVGElement>}
      className={`bridge-svg ${className}`}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}
      width={svgSize.width}
      height={svgSize.height}
    >
      <defs>
        <filter id="bridgeGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {paths}
    </svg>
  );
}

interface TileBridgeProps {
  tileRefs: Map<string, HTMLDivElement | null>;
  connections: { from: string; to: string; color: string; label?: string }[];
  containerRef: React.RefObject<SVGSVGElement | null>;
}

export function TileBridgeLayer({ tileRefs, connections, containerRef }: TileBridgeProps) {
  const [bridges, setBridges] = useState<BridgePath[]>([]);

  useEffect(() => {
    const computeBridges = () => {
      const newBridges: BridgePath[] = [];

      connections.forEach(({ from, to, color, label }) => {
        const fromEl = tileRefs.get(from);
        const toEl = tileRefs.get(to);
        if (!fromEl || !toEl) return;

        const containerRect = containerRef.current?.getBoundingClientRect();
        if (!containerRect) return;

        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();

        const fromCenter = {
          x: fromRect.left + fromRect.width / 2 - containerRect.left,
          y: fromRect.top + fromRect.height / 2 - containerRect.top,
        };
        const toCenter = {
          x: toRect.left + toRect.width / 2 - containerRect.left,
          y: toRect.top + toRect.height / 2 - containerRect.top,
        };

        newBridges.push({
          from: fromCenter,
          to: toCenter,
          color,
          label,
        });
      });

      setBridges(newBridges);
    };

    computeBridges();
    const ro = new ResizeObserver(computeBridges);
    tileRefs.forEach((el) => el && ro.observe(el));
    return () => ro.disconnect();
  }, [tileRefs, connections, containerRef]);

  return <BridgeConnector bridges={bridges} containerRef={containerRef} />;
}