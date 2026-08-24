import { Check, Gauge, Link2, Monitor, Volume2 } from 'lucide-react';
import { SCREEN_SHARE_PROFILES } from '../media/screenShareProfiles.js';

function SourceCard({ source, selected, onSelect, audio = false }) {
  return (
    <button
      type="button"
      className={`screen-share-source ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(source)}
      aria-pressed={selected}
    >
      <span className="screen-share-thumbnail">
        {source.thumbnail ? <img src={source.thumbnail} alt="" draggable="false" /> : source.appIcon ? <img src={source.appIcon} alt="" draggable="false" /> : <span className="screen-share-thumbnail-placeholder">J</span>}
      </span>
      <span className="screen-share-source-copy">
        <strong>{source.name || (source.type === 'screen' ? 'tela inteira' : 'janela')}</strong>
        <small>{audio ? (source.type === 'screen' ? 'todo o áudio da tela' : source.processName || 'áudio deste aplicativo') : (source.type === 'screen' ? 'tela inteira' : 'janela')}</small>
      </span>
      {selected && <Check className="screen-share-selected-check" size={15} aria-hidden="true" />}
    </button>
  );
}

export function ScreenShareDialog({
  appIcon,
  sources,
  loading,
  mediaCapabilities,
  tab,
  onTabChange,
  videoSource,
  audioSource,
  onVideoSource,
  onAudioSource,
  includeAudio,
  onIncludeAudio,
  syncAudio,
  onSyncAudio,
  profileId,
  onProfile,
  onConfirm,
  onCancel,
}) {
  const selectableSources = tab === 'audio'
    ? sources.filter((source) => source.type === 'screen' || source.processId)
    : sources;
  const resolvedAudio = includeAudio ? (syncAudio ? (videoSource?.audioSupported ? videoSource : null) : audioSource) : null;
  const canConfirm = Boolean(videoSource && (!includeAudio || resolvedAudio));

  return (
    <div className="screen-share-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="screen-share-dialog" role="dialog" aria-modal="true" aria-labelledby="screen-share-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="screen-share-titlebar">
          <div className="screen-share-titlebar-label"><img className="room-info-titlebar-icon" src={appIcon} alt="" aria-hidden="true" draggable="false" /><strong id="screen-share-title">JUMP — compartilhar tela</strong></div>
          <button type="button" className="win98-close-control" aria-label="Cancelar compartilhamento" title="Cancelar" onClick={onCancel}>×</button>
        </div>

        <div className="screen-share-tabs" role="tablist" aria-label="Tipo de fonte">
          <button type="button" role="tab" aria-selected={tab === 'video'} className={tab === 'video' ? 'is-active' : ''} onClick={() => onTabChange('video')}><Monitor size={14} /> janela de vídeo</button>
          <button type="button" role="tab" aria-selected={tab === 'audio'} disabled={!includeAudio || syncAudio} className={tab === 'audio' ? 'is-active' : ''} onClick={() => onTabChange('audio')}><Volume2 size={14} /> janela de áudio</button>
        </div>

        <div className="screen-share-body">
          <p>{tab === 'video' ? 'Escolha uma janela ou tela inteira para transmitir.' : 'Escolha o aplicativo cujo áudio será transmitido.'}</p>
          {loading ? (
            <div className="screen-share-empty">procurando telas, janelas e aplicativos...</div>
          ) : selectableSources.length ? (
            <div className="screen-share-grid">
              {selectableSources.map((source) => (
                <SourceCard
                  key={`${tab}:${source.id}`}
                  source={source}
                  audio={tab === 'audio'}
                  selected={(tab === 'video' ? videoSource?.id : audioSource?.id) === source.id}
                  onSelect={tab === 'video' ? onVideoSource : onAudioSource}
                />
              ))}
            </div>
          ) : (
            <div className="screen-share-empty">{tab === 'audio' ? 'nenhum aplicativo de áudio disponível' : 'nenhuma fonte disponível'}</div>
          )}
        </div>

        <div className="screen-share-options">
          <div className="screen-share-selection-info">
            <strong>{videoSource?.name || 'selecione uma janela de vídeo'}</strong>
            <small>{!includeAudio ? 'sem áudio' : resolvedAudio ? `áudio: ${resolvedAudio.name}` : 'selecione uma janela de áudio'}</small>
          </div>

          <fieldset className="screen-share-quality">
            <legend><Gauge size={13} /> modo automático <span className={mediaCapabilities?.hardwareVideoEncoding ? 'is-accelerated' : ''}>{mediaCapabilities?.hardwareVideoEncoding ? 'GPU candidata' : mediaCapabilities ? 'encoder por software' : ''}</span></legend>
            <div>
              {Object.values(SCREEN_SHARE_PROFILES).map((profile) => (
                <button type="button" key={profile.id} className={profileId === profile.id ? 'is-selected' : ''} aria-pressed={profileId === profile.id} onClick={() => onProfile(profile.id)}><strong>{profile.label}</strong><small>{profile.description}</small></button>
              ))}
            </div>
          </fieldset>

          <div className="screen-share-audio-options">
            <label><input type="checkbox" checked={includeAudio} onChange={(event) => onIncludeAudio(event.target.checked)} /><span>incluir áudio</span></label>
            <label className={!includeAudio ? 'is-disabled' : ''}><input type="checkbox" checked={syncAudio} disabled={!includeAudio} onChange={(event) => onSyncAudio(event.target.checked)} /><Link2 size={13} /><span>vincular áudio à janela</span></label>
            {includeAudio && <small>{syncAudio ? 'a fonte de áudio acompanha o vídeo automaticamente' : 'escolha a fonte no botão “janela de áudio”'}</small>}
          </div>
        </div>

        <div className="screen-share-actions">
          <button type="button" className="dialog-primary" disabled={!canConfirm} onClick={() => onConfirm({ videoSource, audioSource: resolvedAudio, includeAudio, profileId })}>compartilhar</button>
          <button type="button" className="dialog-secondary" onClick={onCancel}>cancelar</button>
        </div>
      </div>
    </div>
  );
}
