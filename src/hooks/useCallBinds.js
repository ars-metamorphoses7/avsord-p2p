import { useEffect, useRef, useState } from 'react';
import { CALL_BIND_ACTIONS, eventBind } from '../media/muteBind.js';

function readBinds() {
  const binds = {};
  for (const [action, { storageKey, fallback }] of Object.entries(CALL_BIND_ACTIONS)) {
    try { binds[action] = localStorage.getItem(storageKey) ?? fallback; } catch { binds[action] = fallback; }
  }
  return binds;
}

function saveBind(action, value) {
  try { localStorage.setItem(CALL_BIND_ACTIONS[action].storageKey, value); } catch { /* Best effort only. */ }
}

// Call shortcuts: global on desktop (even with JUMP in the background), and
// page-level in the browser or when the OS refuses the global registration.
export function useCallBinds(handlers, inCallRef) {
  const [binds, setBinds] = useState(readBinds);
  const [recording, setRecording] = useState('');
  const [errors, setErrors] = useState({});
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    let disposed = false;
    const global = {};
    const desktop = window.jumpDesktop;
    const fire = (action) => { if (inCallRef.current && !recording) void handlersRef.current[action]?.(); };
    const unsubscribe = desktop?.onCallBind?.(fire);
    setErrors({});
    for (const action of Object.keys(CALL_BIND_ACTIONS)) {
      desktop?.setCallBind?.(action, recording ? '' : binds[action]).then((result) => {
        if (disposed) return;
        global[action] = result.ok;
        if (!result.ok) setErrors((current) => ({ ...current, [action]: 'Atalho indisponível globalmente (outro programa usa essa combinação). Ele ainda funciona com o JUMP em foco.' }));
      }).catch(() => { if (!disposed) setErrors((current) => ({ ...current, [action]: 'Não foi possível registrar o atalho global.' })); });
    }
    const onKey = (event) => {
      if (event.repeat || event.isComposing) return;
      if (recording) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') { setRecording(''); return; }
        const value = eventBind(event);
        if (!value) return;
        const taken = Object.entries(binds).find(([other, bind]) => other !== recording && bind === value);
        if (taken) {
          setErrors((current) => ({ ...current, [recording]: `Essa combinação já é usada em "${CALL_BIND_ACTIONS[taken[0]].label}".` }));
          return;
        }
        saveBind(recording, value);
        setBinds((current) => ({ ...current, [recording]: value }));
        setRecording('');
        return;
      }
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const value = eventBind(event);
      const action = value && Object.keys(binds).find((candidate) => binds[candidate] === value && !global[candidate]);
      if (action) { event.preventDefault(); fire(action); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { disposed = true; unsubscribe?.(); window.removeEventListener('keydown', onKey, true); };
  }, [binds, recording, inCallRef]);
  const disable = (action) => {
    saveBind(action, '');
    setBinds((current) => ({ ...current, [action]: '' }));
    setRecording('');
  };
  const reset = (action) => {
    const { fallback } = CALL_BIND_ACTIONS[action];
    if (Object.entries(binds).some(([other, bind]) => other !== action && bind === fallback)) return;
    saveBind(action, fallback);
    setBinds((current) => ({ ...current, [action]: fallback }));
    setRecording('');
  };
  return { binds, recording, errors, setRecording, disable, reset };
}
