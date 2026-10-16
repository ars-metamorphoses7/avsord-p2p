import { useCallback, useEffect, useState } from 'react';
import { groupServers, INVITE_ADDRESS_KEY, parseServerAddress, probeSignalServer, serverAddressLabel } from '../network/serverDirectory.js';

function readInviteAddress() {
  try { return localStorage.getItem(INVITE_ADDRESS_KEY) || ''; } catch { return ''; }
}

function publishSessions(saved) {
  if (Array.isArray(saved?.recent)) window.dispatchEvent(new CustomEvent('jump:room-sessions-changed', { detail: saved.recent }));
}

export function ServersDialog({ sessions, currentSignal, currentServer, isAdmin, initialEdit, onNavigate, onClose }) {
  const desktop = globalThis.jumpDesktop;
  const servers = groupServers(sessions, { serverId: currentServer?.id, serverName: currentServer?.name, signal: currentSignal });
  const [status, setStatus] = useState({});
  const [editing, setEditing] = useState(initialEdit || null);
  const [addressDraft, setAddressDraft] = useState(initialEdit ? serverAddressLabel(initialEdit.signal) : '');
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [network, setNetwork] = useState(null);
  const [inviteAddress, setInviteAddress] = useState(readInviteAddress);
  const serverSignals = servers.map((server) => server.signal).join('\n');

  const refresh = useCallback(() => {
    for (const signal of serverSignals.split('\n')) {
      setStatus((current) => ({ ...current, [signal]: { checking: true } }));
      void probeSignalServer(signal).then((result) => setStatus((current) => ({ ...current, [signal]: result })));
    }
  }, [serverSignals]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { desktop?.getNetworkAddresses?.().then(setNetwork).catch(() => {}); }, [desktop]);
  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const statusLabel = (server) => {
    const result = status[server.signal];
    if (!result || result.checking) return 'verificando…';
    if (!result.online) return 'offline';
    if (server.serverId && result.server?.id && result.server.id !== server.serverId) return 'outro servidor neste endereço';
    return 'online';
  };

  const testAddress = async (value) => {
    const signal = parseServerAddress(value);
    if (!signal) {
      setError('Endereço inválido. Use o IP do host, por exemplo 26.10.20.30.');
      return null;
    }
    setBusy(true);
    setError('');
    const result = await probeSignalServer(signal);
    setBusy(false);
    if (!result.online) {
      setError(`Nenhum servidor JUMP respondeu em ${serverAddressLabel(signal)}. Confira o IP e se o host está com o JUMP aberto.`);
      return null;
    }
    return { signal, server: result.server };
  };

  const saveAddress = async (event) => {
    event.preventDefault();
    const found = await testAddress(addressDraft);
    if (!found) return;
    if (editing.serverId && found.server?.id && found.server.id !== editing.serverId
      && !window.confirm(`Esse endereço pertence a outro servidor (${found.server.name || 'sem nome'}). Mover as salas salvas para ele mesmo assim?`)) return;
    publishSessions(await desktop?.relocateServer?.({ serverId: editing.serverId, fromSignal: editing.signal, signal: found.signal }).catch(() => null));
    const wasCurrent = editing.signal === currentSignal || Boolean(editing.serverId && editing.serverId === currentServer?.id);
    setEditing(null);
    if (wasCurrent) onNavigate(found.signal);
    else refresh();
  };

  const addServer = async (event) => {
    event.preventDefault();
    const found = await testAddress(adding);
    if (found) onNavigate(found.signal);
  };

  const forget = async (server) => {
    if (!window.confirm(`Esquecer "${server.serverName || serverAddressLabel(server.signal)}" e as salas salvas dele neste PC?`)) return;
    publishSessions(await desktop?.forgetServer?.({ serverId: server.serverId, signal: server.signal }).catch(() => null));
  };

  const chooseInviteAddress = (address) => {
    setInviteAddress(address);
    try { localStorage.setItem(INVITE_ADDRESS_KEY, address); } catch { /* Best effort only. */ }
  };

  const selectedInviteAddress = network?.addresses?.some((entry) => entry.address === inviteAddress) ? inviteAddress : network?.addresses?.[0]?.address;

  return (
    <div className="app-settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="app-settings-dialog servers-dialog" role="dialog" aria-modal="true" aria-labelledby="servers-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="app-settings-titlebar">
          <div className="app-settings-titlebar-label"><strong id="servers-title">JUMP — servidores</strong></div>
          <button type="button" className="win98-close-control" aria-label="Fechar servidores" onClick={onClose}>×</button>
        </div>
        <div className="app-settings-body">
          <section className="screen-playback-settings">
            <h3>Conectado agora</h3>
            <p><strong>{currentServer?.name || 'servidor'}</strong> · {serverAddressLabel(currentSignal)}{isAdmin ? ' · você é o host e administra todas as salas' : ''}</p>
          </section>

          <section className="screen-playback-settings">
            <h3>Servidores salvos</h3>
            <ul className="servers-list">
              {servers.map((server) => (
                <li key={server.key} className={server.signal === currentSignal ? 'is-current' : ''}>
                  <div className="servers-list-copy">
                    <strong>{server.serverName || serverAddressLabel(server.signal)}</strong>
                    <small>{serverAddressLabel(server.signal)} · {statusLabel(server)}{server.rooms.length ? ` · ${server.rooms.slice(0, 3).join(', ')}` : ''}</small>
                  </div>
                  <div className="servers-list-actions">
                    {server.signal !== currentSignal && <button type="button" onClick={() => onNavigate(server.signal)}>Conectar</button>}
                    {server.signal && <button type="button" onClick={() => { setEditing(server); setAddressDraft(serverAddressLabel(server.signal)); setError(''); }}>Alterar endereço</button>}
                    {server.signal !== currentSignal && desktop?.forgetServer && <button type="button" onClick={() => forget(server)}>Esquecer</button>}
                  </div>
                </li>
              ))}
            </ul>
            <div className="servers-row"><button type="button" onClick={refresh}>Atualizar status</button></div>
          </section>

          {editing && (
            <form className="screen-playback-settings servers-form" onSubmit={saveAddress}>
              <h3>Novo endereço de {editing.serverName || serverAddressLabel(editing.signal)}</h3>
              <p>Use quando o IP do host mudou (Radmin novo, PC formatado). Todas as salas salvas desse servidor passam para o novo endereço.</p>
              <div className="servers-row">
                <input autoFocus value={addressDraft} onChange={(event) => setAddressDraft(event.target.value)} aria-label="Novo endereço do servidor" placeholder="26.10.20.30" />
                <button type="submit" disabled={busy}>{busy ? 'Testando…' : 'Salvar'}</button>
                <button type="button" onClick={() => setEditing(null)}>Cancelar</button>
              </div>
            </form>
          )}

          <form className="screen-playback-settings servers-form" onSubmit={addServer}>
            <h3>Entrar em outro servidor</h3>
            <p>Cole o IP do host (Radmin) ou um link de convite.</p>
            <div className="servers-row">
              <input value={adding} onChange={(event) => setAdding(event.target.value)} aria-label="Endereço do servidor" placeholder="26.10.20.30 ou jump://join?..." />
              <button type="submit" disabled={busy}>{busy ? 'Testando…' : 'Conectar'}</button>
            </div>
          </form>

          {network?.addresses?.length > 0 && (
            <section className="screen-playback-settings">
              <h3>Hospedar neste PC</h3>
              <p>O JUMP sempre roda um servidor neste PC (porta {network.port}). Escolha o endereço que vai nos convites copiados enquanto você estiver nele.</p>
              {network.addresses.map((entry) => (
                <label key={entry.address} className="servers-radio">
                  <input type="radio" name="invite-address" checked={selectedInviteAddress === entry.address} onChange={() => chooseInviteAddress(entry.address)} />
                  {entry.address} <small>({entry.name}{entry.vpn ? ', VPN' : ''})</small>
                </label>
              ))}
            </section>
          )}

          {error && <p className="servers-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}
