export const DEFAULT_MUTE_BIND = 'Control+Shift+M';
export const DEFAULT_DEAFEN_BIND = 'Control+Shift+D';
export const CALL_BIND_ACTIONS = {
  mute: { storageKey: 'jump-mute-bind', fallback: DEFAULT_MUTE_BIND, label: 'Mutar / desmutar microfone' },
  deafen: { storageKey: 'jump-deafen-bind', fallback: DEFAULT_DEAFEN_BIND, label: 'Ensurdecer / ouvir de novo' },
};
export function eventBind(event) {
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code) ? event.code : '';
  if (!key || (!(event.ctrlKey || event.altKey || event.metaKey) && !key.startsWith('F'))) return '';
  return [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key].filter(Boolean).join('+');
}
export function bindLabel(value) {
  return value ? value.replace('Control', 'Ctrl').replace('Super', 'Win') : 'Desativado';
}
