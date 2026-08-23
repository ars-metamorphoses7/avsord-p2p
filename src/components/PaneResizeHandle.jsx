import { useCallback } from 'react';

const MIN_PERCENT = 25;
const MAX_PERCENT = 75;

function clamp(value) {
  return Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, value));
}

export function PaneResizeHandle({ value, onChange }) {
  const startResize = useCallback((event) => {
    if (event.button !== 0) return;
    const container = event.currentTarget.parentElement;
    if (!container) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add('is-resizing-call-chat');

    const move = (moveEvent) => {
      const bounds = container.getBoundingClientRect();
      if (!bounds.width) return;
      onChange(clamp(((moveEvent.clientX - bounds.left) / bounds.width) * 100));
    };
    const stop = () => {
      document.body.classList.remove('is-resizing-call-chat');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }, [onChange]);

  const handleKeyDown = (event) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') onChange(clamp(value - step));
    else if (event.key === 'ArrowRight') onChange(clamp(value + step));
    else if (event.key === 'Home') onChange(MIN_PERCENT);
    else if (event.key === 'End') onChange(MAX_PERCENT);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className="call-chat-resizer"
      role="separator"
      aria-label="Redimensionar chamada e chat"
      aria-orientation="vertical"
      aria-valuemin={MIN_PERCENT}
      aria-valuemax={MAX_PERCENT}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={handleKeyDown}
    ><span aria-hidden="true" /></div>
  );
}
