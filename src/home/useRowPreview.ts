import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetRow } from '../../shared/types';
import { HOVER_CLOSE_GRACE_MS, HOVER_OPEN_DELAY_MS, HOVER_SLOP_PX } from './motion';

/**
 * Hover / focus / tap intent for the board rows.
 *
 * Three problems this solves, each of which a naive `onMouseEnter` gets wrong:
 *
 *   1. SWEEPING THE MOUSE. Moving the pointer across a column of 20 rows would
 *      fire 20 opens. The first preview opens at once, but switching an
 *      already-open preview to another row waits for intent, so a sweep only
 *      flashes the row it entered on.
 *
 *   2. THE GAP BETWEEN ROW AND POPUP. The pointer has to leave the row to get
 *      to the popup, so a close-on-leave closes it mid-gesture. A grace period
 *      lets the pointer travel.
 *
 *   3. TOUCH. On a phone a pointerdown is a tap, and hover does not exist. A
 *      touch pointer must never schedule an open — it would open the popup
 *      under the finger and then immediately be dismissed.
 *
 * Clicking a row PINS the popup: it then survives pointer movement and closes
 * only on Escape or an outside click.
 */

export type PreviewState = {
  row: AssetRow | null;
  anchor: HTMLElement | null;
  pinned: boolean;
};

export function useRowPreview(rows: AssetRow[]) {
  const [state, setState] = useState<PreviewState>({ row: null, anchor: null, pinned: false });
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const clearTimers = () => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };

  const close = useCallback(() => {
    clearTimers();
    setState({ row: null, anchor: null, pinned: false });
  }, []);

  /** Open now, no intent delay — used by keyboard focus and tap. */
  const openNow = useCallback((row: AssetRow, anchor: HTMLElement | null, pinned = false) => {
    clearTimers();
    anchorRef.current = anchor;
    setState({ row, anchor, pinned });
  }, [clearTimers]);

  const scheduleOpen = useCallback((row: AssetRow, anchor: HTMLElement | null) => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      anchorRef.current = anchor;
      setState((prev) => (prev.pinned ? prev : { row, anchor, pinned: false }));
    }, HOVER_OPEN_DELAY_MS);
  }, []);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setState((prev) => (prev.pinned ? prev : { row: null, anchor: null, pinned: false }));
    }, HOVER_CLOSE_GRACE_MS);
  }, []);

  // Hover handlers. `pointerType === 'touch'` never schedules an open: on a
  // phone this is a tap, handled by onActivate.
  const onHoverRow = useCallback((row: AssetRow | null, anchor: HTMLElement | null) => {
    if (!row) { scheduleClose(); return; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    // No preview open: show it now, so the 300ms acceptance window is spent on
    // rendering rather than intent. Only switching between rows (a sweep) pays
    // the delay.
    if (state.row) scheduleOpen(row, anchor);
    else openNow(row, anchor);
  }, [state.row, openNow, scheduleOpen, scheduleClose]);

  const onFocusRow = useCallback((row: AssetRow | null, anchor: HTMLElement | null) => {
    if (row) openNow(row, anchor);
  }, [openNow]);

  // The popup itself must keep the preview alive while the pointer is inside it.
  const onPopupEnter = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  const onPopupLeave = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setState((prev) => (prev.pinned ? prev : { row: null, anchor: null, pinned: false }));
  }, []);

  const pin = useCallback((row: AssetRow, anchor: HTMLElement | null) => {
    openNow(row, anchor, true);
  }, [openNow]);

  // Outside click closes a pinned popup; it must not close on the click that
  // pinned it, so the check is deferred past the current event.
  useEffect(() => {
    if (!state.pinned) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-testid="row-preview"]') || t?.closest('[data-testid="board-row"]')) return;
      close();
    };
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDown); };
  }, [state.pinned, close]);

  useEffect(() => clearTimers, []);

  /** Step to the neighbouring coin (C1). Order follows the board, not the DOM. */
  const step = useCallback((delta: number) => {
    setState((prev) => {
      if (!prev.row) return prev;
      const i = rows.findIndex((r) => r.base === prev.row!.base);
      if (i < 0) return prev;
      const next = rows[(i + delta + rows.length) % rows.length];
      return { row: next, anchor: anchorRef.current, pinned: prev.pinned };
    });
  }, [rows]);

  return {
    state,
    close,
    pin,
    step,
    handlers: {
      onRowPointerEnter: (row: AssetRow, el: HTMLElement) => onHoverRow(row, el),
      onRowPointerLeave: (ev: React.PointerEvent) => {
        if (ev.pointerType === 'touch') return;
        onHoverRow(null, null);
      },
      onRowFocus: (row: AssetRow, el: HTMLElement) => onFocusRow(row, el),
      onRowBlur: () => { if (!anchorRef.current) scheduleClose(); },
      onRowActivate: (row: AssetRow, el: HTMLElement | null) => pin(row, el),
      onPopupEnter,
      onPopupLeave,
    },
    slopPx: HOVER_SLOP_PX,
  };
}