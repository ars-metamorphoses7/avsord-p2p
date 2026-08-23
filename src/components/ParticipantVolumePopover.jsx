import { MonitorUp, RotateCcw, Volume2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function ParticipantVolumePopover({ anchor, name, values, sharing, onChange, onClose }) {
  const popoverRef = useRef(null);

  useEffect(() => {
    const closeOnPointer = (event) => {
      if (!popoverRef.current?.contains(event.target)) onClose();
    };
    const closeOnKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', closeOnPointer);
    window.addEventListener('keydown', closeOnKey);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointer);
      window.removeEventListener('keydown', closeOnKey);
    };
  }, [onClose]);

  const left = Math.max(8, Math.min(Number(anchor?.x) || 8, window.innerWidth - 300));
  const top = Math.max(32, Math.min(Number(anchor?.y) || 32, window.innerHeight - 230));
  return (
    <div ref={popoverRef} className="participant-volume-popover" role="dialog" aria-labelledby="participant-volume-title" style={{ left, top }} onContextMenu={(event) => event.preventDefault()}>
      <div className="participant-volume-titlebar">
        <strong id="participant-volume-title">volume — {name}</strong>
        <button type="button" className="win98-close-control" onClick={onClose} aria-label="Fechar volumes"><X size={12} /></button>
      </div>
      <div className="participant-volume-body">
        <label>
          <span><Volume2 size={14} /> microfone da pessoa <output>{values.voice}%</output></span>
          <input type="range" min="0" max="200" step="5" value={values.voice} onChange={(event) => onChange({ ...values, voice: Number(event.target.value) })} />
        </label>
        <label className={!sharing ? 'is-disabled' : ''}>
          <span><MonitorUp size={14} /> áudio da transmissão <output>{values.stream}%</output></span>
          <input type="range" min="0" max="200" step="5" disabled={!sharing} value={values.stream} onChange={(event) => onChange({ ...values, stream: Number(event.target.value) })} />
        </label>
        <button type="button" className="participant-volume-reset" onClick={() => onChange({ voice: 100, stream: 100 })}><RotateCcw size={12} /> restaurar 100%</button>
        <small>clique direito no participante para abrir novamente</small>
      </div>
    </div>
  );
}
