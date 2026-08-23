const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const START_BUFFER_SECONDS = 0.06;
const MAX_BUFFER_SECONDS = 0.24;

function pcm16ToAudioBuffer(context, bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const frameCount = Math.floor(view.byteLength / (Int16Array.BYTES_PER_ELEMENT * CHANNELS));
  if (!frameCount) return null;
  const samples = new Int16Array(view.buffer, view.byteOffset, frameCount * CHANNELS);
  const buffer = context.createBuffer(CHANNELS, frameCount, SAMPLE_RATE);
  for (let channel = 0; channel < CHANNELS; channel += 1) {
    const output = buffer.getChannelData(channel);
    for (let frame = 0; frame < frameCount; frame += 1) {
      output[frame] = samples[(frame * CHANNELS) + channel] / 32768;
    }
  }
  return buffer;
}

export async function createDesktopAudioBridge(desktop, target) {
  if (!desktop?.startDesktopAudio || !desktop?.onDesktopAudioData) {
    throw new Error('Captura de áudio por aplicativo indisponível nesta plataforma.');
  }
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error('O mecanismo de áudio do sistema não está disponível.');

  const context = new AudioContextClass({ latencyHint: 'interactive', sampleRate: SAMPLE_RATE });
  const destination = context.createMediaStreamDestination();
  let nextStart = context.currentTime + START_BUFFER_SECONDS;
  let stopped = false;

  const unsubscribe = desktop.onDesktopAudioData((chunk) => {
    if (stopped || context.state === 'closed') return;
    const buffer = pcm16ToAudioBuffer(context, chunk);
    if (!buffer) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    if (nextStart < context.currentTime || nextStart - context.currentTime > MAX_BUFFER_SECONDS) {
      nextStart = context.currentTime + START_BUFFER_SECONDS;
    }
    source.start(nextStart);
    nextStart += buffer.duration;
  });

  try {
    await context.resume();
    const result = await desktop.startDesktopAudio(target);
    if (!result?.ok) throw new Error(result?.message || 'Não foi possível capturar o áudio selecionado.');
  } catch (error) {
    unsubscribe?.();
    await context.close().catch(() => {});
    throw error;
  }

  return {
    stream: destination.stream,
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      await desktop.stopDesktopAudio?.().catch(() => {});
      destination.stream.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => {});
    },
  };
}
