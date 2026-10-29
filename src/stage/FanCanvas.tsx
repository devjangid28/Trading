import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FanAsset, FanPayload } from '../../shared/types';
import { fmtPct, fmtPrice } from '../lib/format';
import {
  FAN_GEO, FAN_H, FAN_HIT, FAN_MID, FAN_SET, FAN_W,
  buildScale, buildSeries, symlog, threadColor, type FanSeries, type FanScale,
} from './fan';

/**
 * The 24h fan.
 *
 * Three canvas layers operate in the reference stage's own pixel space, so the
 * whole page can be `transform: scale()`d and the fan stays aligned with the
 * SVG rails and the absolutely-positioned card lanes:
 *   - `ltThreads`  — the 98 threads + gridlines. Redrawn only on a data change,
 *                    a hover change, or while the load-in reveal is running.
 *   - `ltDots`     — kept as an empty layer: the calm-terminal rendition has
 *                    no travelling particles, so this canvas stays cleared.
 *   - an invisible overlay div carries pointer events; hit-testing is done in
 *     JS against the polylines (98 segments per column is cheaper than a per-
 *     pixel readback and gives a stable 8px grab radius).
 *
 * A thread's colour is its own end sign, never the board's: a coin that ends 0
 * up but spent the day negative is drawn red-to-green by shape, and its label
 * still reads its real 24h change.
 */

const REVEAL_MS = 700;

interface Props {
  fan: FanPayload;
  active: string | null;
  sector: string | null;
  onHover: (base: string | null) => void;
  onSelect: (base: string) => void;
  onClear: () => void;
}

interface Line extends FanSeries {
  local: { x: number; y: number }[];
}

function toLocal(s: FanSeries): Line {
  return {
    ...s,
    local: s.pts.map((p) => ({ x: p.x - FAN_GEO.x0, y: p.y - FAN_GEO.top })),
  };
}

/** Threads that should be bright, in draw order (background first). */
function emphasis(assets: FanAsset[], line: Line): 'set' | 'back' {
  const i = assets.indexOf(line.asset);
  if (i >= 0 && (i < FAN_SET || i >= assets.length - FAN_SET)) return 'set';
  return 'back';
}

export function FanCanvas({ fan, active, sector, onHover, onSelect, onClear }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLCanvasElement>(null);
  const dotRef = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; asset: FanAsset; rank: number } | null>(null);

  const scale = useMemo<FanScale>(() => buildScale(fan.assets), [fan]);
  const series = useMemo(() => buildSeries(fan.assets, scale), [fan, scale]);
  const lines = useMemo<Line[]>(() => series.map(toLocal), [series]);
  const seriesKey = `${fan.updatedAt}:${fan.assets.length}`;

  // Reveal progress (0..1) for the draw-in animation.
  const progRef = useRef(1);
  const revealRef = useRef(0);

  const drawStatic = useCallback((prog: number) => {
    const cvs = threadRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, FAN_W, FAN_H);

    // Gridlines at a few symmetric % levels, faint.
    ctx.lineWidth = 1;
    const levels = [0.5, 1, 2, 5, 10, 20].filter((v) => v <= scale.maxAbs * 1.02);
    for (const lv of levels) {
      for (const sign of [1, -1]) {
        const y = FAN_MID - symlog(sign * lv) * scale.scaleY - FAN_GEO.top;
        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(FAN_W, y);
        ctx.stroke();
      }
    }

    const n = FAN_SET;
    lines.forEach((line, idx) => {
      const kind = emphasis(fan.assets, line);
      const stagger = (idx % n) / n * 0.22;
      const t = Math.max(0, Math.min(1, (prog - stagger) / (1 - stagger || 1)));
      if (t <= 0) return;
      const count = Math.max(2, Math.ceil(t * line.local.length));

      const color = threadColor(line.final);
      let alpha: number;
      let width: number;
      if (sector !== null) {
        const inSec = line.asset.sector === sector;
        alpha = inSec ? 0.9 : 0.05;
        width = inSec ? 1.5 : 0.6;
      } else if (active !== null) {
        const isActive = line.asset.base === active;
        alpha = isActive ? 0.98 : 0.05;
        width = isActive ? 2 : 0.7;
      } else if (kind === 'set') {
        alpha = 0.65;
        width = 1.1;
      } else {
        alpha = 0.16;
        width = 0.7;
      }

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowBlur = 0;
      const pts = line.local;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < count; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Head dot at the thread's end.
      if (t >= 1) {
        const last = pts[pts.length - 1];
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(last.x, last.y, active === line.asset.base || (sector !== null && line.asset.sector === sector) ? 3 : 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
  }, [lines, fan.assets, scale, active, sector]);

  // Start (or restart) the reveal whenever the payload changes.
  useEffect(() => {
    revealRef.current = 0;
    progRef.current = 0;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / REVEAL_MS);
      progRef.current = p;
      drawStatic(p);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [seriesKey, drawStatic]);

  // A hover change snaps to the final frame without replaying the reveal.
  useEffect(() => {
    if (progRef.current >= 1) drawStatic(1);
  }, [active, drawStatic]);

  // Particle layer is static in the calm-terminal rendition: the travelling
  // dots were decorative motion, so this canvas stays cleared (kept for the
  // two-canvas contract in the qa spec).
  useEffect(() => {
    const cvs = dotRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, FAN_W, FAN_H);
  }, []);

  // Pointer handling — hit-test against the polylines.
  const onMove = useCallback((e: React.MouseEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const sx = (e.clientX - r.left) / (r.width / FAN_W); // local x
    const sy = (e.clientY - r.top) / (r.height / FAN_H); // local y
    let best: Line | null = null;
    let bestD = FAN_HIT * FAN_HIT;
    for (const l of lines) {
      const pts = l.local;
      if (sx < pts[0].x - 6 || sx > pts[pts.length - 1].x + 6) continue;
      const step = FAN_W / (pts.length - 1);
      const idx = Math.max(0, Math.min(pts.length - 2, Math.floor((sx - pts[0].x) / step)));
      for (let k = idx; k <= idx + 1 && k < pts.length - 1; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1;
        let tt = ((sx - a.x) * dx + (sy - a.y) * dy) / len2;
        tt = Math.max(0, Math.min(1, tt));
        const px = a.x + dx * tt;
        const py = a.y + dy * tt;
        const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
        if (d < bestD) {
          bestD = d;
          best = l;
        }
      }
    }
    if (best) {
      const rank = fan.assets.indexOf(best.asset) + 1;
      const last = best.local[best.local.length - 1];
      setTip({ x: last.x + 8, y: last.y - 6, asset: best.asset, rank });
      onHover(best.asset.base);
    } else {
      setTip(null);
      onHover(null);
    }
  }, [lines, fan.assets, onHover]);

  const onLeave = useCallback(() => {
    setTip(null);
    onHover(null);
  }, [onHover]);

  const onClick = useCallback(() => {
    if (tip) onSelect(tip.asset.base);
    else onClear();
  }, [tip, onSelect, onClear]);

  return (
    <div
      ref={wrapRef}
      className="fan-plot"
      style={{ left: FAN_GEO.x0, top: FAN_GEO.top, width: FAN_W, height: FAN_H }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      <canvas ref={threadRef} className="fan-cv" width={FAN_W} height={FAN_H} style={{ width: FAN_W, height: FAN_H }} />
      <canvas ref={dotRef} className="fan-cv" width={FAN_W} height={FAN_H} style={{ width: FAN_W, height: FAN_H }} />
      {tip && (
        <div className="fan-tip" style={{ left: tip.x, top: tip.y }}>
          <div className="fan-tip-row">
            <b>{tip.asset.displayTicker || tip.asset.base}</b>
            <span className={`fan-tip-chg ${tip.asset.changePct >= 0 ? 'pos' : 'neg'}`}>{fmtPct(tip.asset.changePct)}</span>
          </div>
          <div className="fan-tip-sec">{tip.asset.sector}</div>
          <div className="fan-tip-row mono">
            <span>RANK {tip.rank}</span>
            <span>${fmtPrice(tip.asset.price)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
