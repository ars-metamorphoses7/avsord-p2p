import { useEffect, useRef } from 'react';
import { PixelIcon } from './Win98Icons.jsx';

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
        <div className="participant-volume-titlebar-label"><PixelIcon name="volume" size={14} /><strong id="participant-volume-title">Volume — {name}</strong></div>
        <button type="button" className="win98-close-control" onClick={onClose} aria-label="Fechar volumes">×</button>
      </div>
      <div className="participant-volume-body">
        <label>
          <span><PixelIcon name="mic" size={14} /> Microfone <output>{values.voice}%</output></span>
          <input type="range" min="0" max="200" step="5" value={values.voice} onChange={(event) => onChange({ ...values, voice: Number(event.target.value) })} />
        </label>
        <label className={!sharing ? 'is-disabled' : ''}>
          <span><PixelIcon name="screen" size={14} /> Áudio da transmissão <output>{values.stream}%</output></span>
          <input type="range" min="0" max="200" step="5" disabled={!sharing} value={values.stream} onChange={(event) => onChange({ ...values, stream: Number(event.target.value) })} />
        </label>
        <div className="participant-volume-footer">
          <button type="button" className="participant-volume-reset" onClick={() => onChange({ voice: 100, stream: 100 })}><PixelIcon name="reset" size={12} /> Restaurar 100%</button>
        </div>
        <small>Clique direito no participante para abrir novamente.</small>
      </div>
    </div>
  );
}
