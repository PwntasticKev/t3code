import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  constrainPaneSizes,
  equalPaneSizes,
  MIN_TERMINAL_PANE_PX,
  paneBoundaryOffsets,
  paneGridTemplate,
  resizeAdjacentPanes,
  resolvePaneSizes,
  type TerminalSplitDirection,
} from "~/terminal/splitPaneSizes";

interface TerminalSplitPanesProps {
  terminalIds: readonly string[];
  direction: TerminalSplitDirection;
  activeTerminalId: string;
  sizes: readonly number[] | undefined;
  onSizesChange: (sizes: number[]) => void;
  onPaneActivate: (terminalId: string) => void;
  onResizeEnd: () => void;
  renderTerminal: (terminalId: string) => ReactNode;
}

interface PointerState {
  pointerId: number;
  handleIndex: number;
  target: HTMLDivElement;
  direction: TerminalSplitDirection;
  startClientX: number;
  startClientY: number;
  pendingClientX: number;
  pendingClientY: number;
  startSizes: number[];
  containerPx: number;
}

function sizesDiffer(left: readonly number[], right: readonly number[]) {
  return left.some((size, index) => size !== right[index]);
}

/** Renders terminal panes with frame-synchronous, directly manipulated split handles. */
export function TerminalSplitPanes({
  terminalIds,
  direction,
  activeTerminalId,
  sizes,
  onSizesChange,
  onPaneActivate,
  onResizeEnd,
  renderTerminal,
}: TerminalSplitPanesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerPxRef = useRef(0);
  const renderedContainerPxRef = useRef(0);
  const [containerPx, setContainerPx] = useState(0);
  const latestSizesRef = useRef<number[]>([]);
  const pointerStateRef = useRef<PointerState | null>(null);
  const pendingRafRef = useRef<number | null>(null);
  const handleStateRef = useRef<Array<HTMLDivElement | null>>([]);
  const callbacksRef = useRef({ onSizesChange, onResizeEnd });
  useLayoutEffect(() => {
    callbacksRef.current = { onSizesChange, onResizeEnd };
  }, [onSizesChange, onResizeEnd]);

  const resolved = resolvePaneSizes(sizes, terminalIds.length);
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  const displayed = constrainPaneSizes(resolved, containerPx, MIN_TERMINAL_PANE_PX[direction]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextContainerPx =
        direction === "horizontal" ? entry.contentRect.width : entry.contentRect.height;
      containerPxRef.current = nextContainerPx;
      const currentSizes = resolvedRef.current;
      const minimum = MIN_TERMINAL_PANE_PX[direction];
      const previous = constrainPaneSizes(currentSizes, renderedContainerPxRef.current, minimum);
      const next = constrainPaneSizes(currentSizes, nextContainerPx, minimum);
      if (!sizesDiffer(previous, next)) return;
      renderedContainerPxRef.current = nextContainerPx;
      setContainerPx(nextContainerPx);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [direction, sizes, terminalIds.length]);

  const writeSizesToDom = useCallback(
    (nextSizes: readonly number[]) => {
      const pointerState = pointerStateRef.current;
      const activeDirection = pointerState?.direction ?? direction;
      const container = containerRef.current;
      if (!container) return;
      const template = paneGridTemplate(nextSizes);
      const horizontal = activeDirection === "horizontal";
      container.style.gridTemplateColumns = horizontal ? template : "";
      container.style.gridTemplateRows = horizontal ? "" : template;
      for (const [index, offset] of paneBoundaryOffsets(nextSizes).entries()) {
        const handle = handleStateRef.current[index];
        if (!handle) continue;
        const position = `calc(${offset * 100}%)`;
        handle.style.left = horizontal ? position : "";
        handle.style.top = horizontal ? "" : position;
      }
    },
    [direction],
  );

  const flushPending = useCallback(() => {
    if (pendingRafRef.current !== null) {
      cancelAnimationFrame(pendingRafRef.current);
      pendingRafRef.current = null;
    }
    const state = pointerStateRef.current;
    if (!state) return;
    const position = state.direction === "horizontal" ? state.pendingClientX : state.pendingClientY;
    const start = state.direction === "horizontal" ? state.startClientX : state.startClientY;
    const nextSizes = resizeAdjacentPanes({
      sizes: state.startSizes,
      handleIndex: state.handleIndex,
      deltaPx: position - start,
      containerPx: state.containerPx,
      minPanePx: MIN_TERMINAL_PANE_PX[state.direction],
    });
    writeSizesToDom(nextSizes);
    latestSizesRef.current = nextSizes;
  }, [writeSizesToDom]);

  const finishDrag = useCallback(() => {
    const state = pointerStateRef.current;
    if (!state) return;
    flushPending();
    pointerStateRef.current = null;
    try {
      if (state.target.hasPointerCapture(state.pointerId)) {
        state.target.releasePointerCapture(state.pointerId);
      }
    } catch {
      // Capture may already have been released by the browser.
    }
    state.target.removeAttribute("data-dragging");
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");

    const distance = Math.hypot(
      state.pendingClientX - state.startClientX,
      state.pendingClientY - state.startClientY,
    );
    const changed = sizesDiffer(state.startSizes, latestSizesRef.current);
    if (changed && distance > 2) {
      callbacksRef.current.onSizesChange(latestSizesRef.current);
      callbacksRef.current.onResizeEnd();
    } else {
      latestSizesRef.current = state.startSizes;
      writeSizesToDom(state.startSizes);
    }
  }, [flushPending, writeSizesToDom]);

  useLayoutEffect(() => {
    const displayedSizes = pointerStateRef.current ? latestSizesRef.current : displayed;
    latestSizesRef.current = displayedSizes;
    writeSizesToDom(displayedSizes);
  });

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const state = pointerStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      state.pendingClientX = event.clientX;
      state.pendingClientY = event.clientY;
      if (pendingRafRef.current !== null) return;
      pendingRafRef.current = requestAnimationFrame(() => {
        pendingRafRef.current = null;
        flushPending();
      });
    };
    const onPointerEnd = (event: PointerEvent) => {
      const state = pointerStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      if (event.type === "pointerup") {
        state.pendingClientX = event.clientX;
        state.pendingClientY = event.clientY;
      }
      finishDrag();
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("blur", finishDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", finishDrag);
      finishDrag();
      if (pendingRafRef.current !== null) cancelAnimationFrame(pendingRafRef.current);
    };
  }, [finishDrag, flushPending]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>, handleIndex: number) => {
    if (event.button !== 0 || pointerStateRef.current) return;
    const dragContainerPx = containerPxRef.current;
    if (dragContainerPx <= 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    pointerStateRef.current = {
      pointerId: event.pointerId,
      handleIndex,
      target: event.currentTarget,
      direction,
      startClientX: event.clientX,
      startClientY: event.clientY,
      pendingClientX: event.clientX,
      pendingClientY: event.clientY,
      startSizes: displayed,
      containerPx: dragContainerPx,
    };
    latestSizesRef.current = displayed;
    event.currentTarget.dataset.dragging = "true";
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, handleIndex: number) => {
    if (pointerStateRef.current) return;

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      callbacksRef.current.onSizesChange(equalPaneSizes(terminalIds.length));
      callbacksRef.current.onResizeEnd();
      return;
    }

    const step = event.shiftKey ? 96 : 24;
    const deltaPx =
      direction === "horizontal"
        ? event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : undefined
        : event.key === "ArrowUp"
          ? -step
          : event.key === "ArrowDown"
            ? step
            : undefined;
    if (deltaPx === undefined) return;

    event.preventDefault();
    event.stopPropagation();
    const next = resizeAdjacentPanes({
      sizes: displayed,
      handleIndex,
      deltaPx,
      containerPx: containerPxRef.current,
      minPanePx: MIN_TERMINAL_PANE_PX[direction],
    });
    callbacksRef.current.onSizesChange(next);
    callbacksRef.current.onResizeEnd();
  };

  // Mid-drag re-renders are corrected by the layout effect, which re-applies latestSizesRef.
  const offsets = paneBoundaryOffsets(displayed);
  const gridStyle =
    direction === "horizontal"
      ? { gridTemplateColumns: paneGridTemplate(displayed) }
      : { gridTemplateRows: paneGridTemplate(displayed) };

  return (
    <div
      ref={containerRef}
      className="relative grid h-full w-full min-w-0 gap-0 overflow-hidden"
      style={gridStyle}
    >
      {terminalIds.map((terminalId) => (
        <div
          key={terminalId}
          className={`min-h-0 min-w-0 ${
            direction === "vertical" ? "border-t first:border-t-0" : "border-l first:border-l-0"
          } ${terminalId === activeTerminalId ? "border-border" : "border-border/70"}`}
          onMouseDown={() => {
            if (terminalId !== activeTerminalId) onPaneActivate(terminalId);
          }}
        >
          <div className="h-full">{renderTerminal(terminalId)}</div>
        </div>
      ))}
      {offsets.map((offset: number, handleIndex: number) => (
        <div
          key={`handle-after-${terminalIds[handleIndex]}`}
          ref={(element) => {
            handleStateRef.current[handleIndex] = element;
          }}
          className={`group absolute z-20 select-none touch-none outline-none ${
            direction === "horizontal"
              ? "bottom-0 top-0 w-2 -translate-x-1/2 cursor-col-resize"
              : "left-0 right-0 h-2 -translate-y-1/2 cursor-row-resize"
          }`}
          style={
            direction === "horizontal"
              ? { left: `calc(${offset * 100}%)` }
              : { top: `calc(${offset * 100}%)` }
          }
          role="separator"
          tabIndex={0}
          aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
          aria-label="Resize terminal panes"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(offset * 100)}
          onPointerDown={(event) => startDrag(event, handleIndex)}
          onKeyDown={(event) => handleKeyDown(event, handleIndex)}
          onLostPointerCapture={(event) => {
            if (pointerStateRef.current?.pointerId === event.pointerId) finishDrag();
          }}
          onDoubleClick={() => {
            callbacksRef.current.onSizesChange(equalPaneSizes(terminalIds.length));
            callbacksRef.current.onResizeEnd();
          }}
        >
          <span
            aria-hidden
            className={`pointer-events-none absolute bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-data-[dragging]:bg-primary/60 ${
              direction === "horizontal"
                ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
                : "inset-x-0 top-1/2 h-px -translate-y-1/2"
            }`}
          />
        </div>
      ))}
    </div>
  );
}
