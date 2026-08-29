export function fieldDiagnosticsStatus(config = {}) {
  if (config?.activationSource === 'environment') return 'Ativado — forçado pelo ambiente';
  return config?.enabled === true ? 'Ativado' : 'Desativado';
}

export function shouldShowFieldDiagnosticsIndicator({ enabled, inCall } = {}) {
  return enabled === true && inCall === true;
}
