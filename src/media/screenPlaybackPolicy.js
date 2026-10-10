import { evaluatePlaybackBufferAdaptation, screenShareProfile } from './screenShareProfiles.js';

export const SCREEN_PLAYBACK_KEY = 'jump-screen-playback-policy';
export const SCREEN_PLAYBACK_OPTIONS = [
  { id: 'responsive', label: 'Responsivo', description: 'Menos atraso, com proteção adaptativa para rede instável.' },
  { id: 'auto', label: 'Automático do sistema', description: 'O WebRTC escolhe o buffer de reprodução.' },
  { id: 'legacy', label: 'Compatibilidade', description: 'Usa a proteção de reprodução da versão anterior.' },
];

export function readScreenPlaybackPolicy() {
  try {
    const saved = globalThis.localStorage?.getItem(SCREEN_PLAYBACK_KEY);
    return SCREEN_PLAYBACK_OPTIONS.some(option => option.id === saved) ? saved : 'responsive';
  } catch { return 'responsive'; }
}

export function saveScreenPlaybackPolicy(policy) {
  if (!SCREEN_PLAYBACK_OPTIONS.some(option => option.id === policy)) return false;
  try { globalThis.localStorage?.setItem(SCREEN_PLAYBACK_KEY, policy); return true; }
  catch { return false; }
}

const metric = value => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function setReceiverPlaybackBuffer(receiver, targetMs) {
  if (!receiver || !('jitterBufferTarget' in receiver)) return false;
  try {
    const target = targetMs === null ? null : Math.max(0, Number(targetMs) || 0);
    if (receiver.jitterBufferTarget === target) return true;
    receiver.jitterBufferTarget = target;
    return true;
  } catch { return false; }
}

export function evaluateScreenPlayback(previous, profileId, diagnostics = {}, policy = readScreenPlaybackPolicy()) {
  const profile = screenShareProfile(profileId);
  const streamKey = diagnostics.streamKey ?? null;
  const current = previous?.profileId === profile.id && previous?.policy === policy
    && previous?.streamKey === streamKey ? previous : null;
  if (policy === 'legacy') {
    return { ...evaluatePlaybackBufferAdaptation(current, profile.id, diagnostics), policy, streamKey };
  }
  if (policy === 'auto') {
    return { profileId: profile.id, policy, streamKey, targetMs: null, reason: 'runtime-default' };
  }
  const base = 50;
  const maximum = 180;
  const jitterMs = metric(diagnostics.jitterMs);
  const lossRatio = metric(diagnostics.packetLossRatio);
  const freezeCount = metric(diagnostics.freezeCount);
  const framesDropped = metric(diagnostics.framesDropped);
  const freezeDelta = freezeCount !== null && current?.freezeCount != null
    ? Math.max(0, freezeCount - current.freezeCount) : 0;
  const droppedDelta = framesDropped !== null && current?.framesDropped != null
    ? Math.max(0, framesDropped - current.framesDropped) : 0;
  // A freeze/drop alone may originate at capture, decode, or a source switch.
  // Buffering longer cannot repair that. Require evidence of network pressure.
  const networkPressure = (jitterMs !== null && jitterMs >= 25)
    || (lossRatio !== null && lossRatio >= 0.01);
  const pressureSamples = networkPressure ? (current?.pressureSamples || 0) + 1 : 0;
  const stable = jitterMs !== null && jitterMs < 15 && lossRatio !== null && lossRatio < 0.005;
  let stableSamples = stable ? (current?.stableSamples || 0) + 1 : 0;
  let targetMs = current?.targetMs ?? base;
  let reason = 'hold';
  if (pressureSamples >= 2) {
    const desired = Math.min(maximum, base + Math.max(0, (jitterMs ?? 0) - 10) * 2
      + (freezeDelta > 0 || droppedDelta >= 2 ? 30 : 0) + ((lossRatio ?? 0) >= 0.01 ? 20 : 0));
    targetMs = Math.max(targetMs, Math.round(desired));
    reason = 'network-protection';
    stableSamples = 0;
  } else if (stableSamples >= 3) {
    targetMs = Math.max(base, targetMs - 30);
    stableSamples = 0;
    reason = targetMs === base ? 'baseline' : 'stable-decay';
  }
  return { profileId: profile.id, policy, streamKey, targetMs, stableSamples,
    pressureSamples, freezeCount, framesDropped, freezeDelta, droppedDelta,
    jitterMs, lossRatio, reason };
}

export function playbackDiagnostics(telemetry, streamKey) {
  return {
    streamKey,
    jitterMs: telemetry.derived.inboundJitterMs,
    packetLossRatio: telemetry.derived.inboundPacketLossRatio,
    freezeCount: telemetry.inbound.freezeCount,
    framesDropped: telemetry.inbound.framesDropped,
  };
}
