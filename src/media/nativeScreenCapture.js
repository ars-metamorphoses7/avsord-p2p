// Renderer side of the Windows native capture (electron/native-capture.cjs).
// Frames arrive through a MessagePort from the preload and are written into a
// MediaStreamTrackGenerator, which then goes through the same WebRTC senders
// as a Chromium capture track.
const FIRST_FRAME_TIMEOUT_MS = 3_000;

export function canUseNativeCapture(desktop, source) {
  return Boolean(desktop?.nativeCaptureSupported
    && typeof desktop.startNativeCapture === 'function'
    && typeof globalThis.MediaStreamTrackGenerator === 'function'
    && /^(screen|window):/.test(String(source?.id || '')));
}

/**
 * Starts the native capture for a desktop source. Resolves to a MediaStream
 * with one video track, or rejects (after cleaning up) so the caller can fall
 * back to Chromium's capturer.
 */
export async function startNativeScreenCapture(desktop, source, { firstFrameTimeoutMs = FIRST_FRAME_TIMEOUT_MS } = {}) {
  const generator = new globalThis.MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  const channel = new MessageChannel();
  const size = { width: 0, height: 0 };
  let stopped = false;
  let receivedFirstFrame;
  const firstFrame = new Promise((resolve) => { receivedFirstFrame = resolve; });
  let removeEndedListener = () => {};

  const stopNative = () => {
    if (stopped) return;
    stopped = true;
    removeEndedListener();
    channel.port1.onmessage = null;
    channel.port1.close();
    void desktop.stopNativeCapture?.()?.catch?.(() => {});
  };

  channel.port1.onmessage = ({ data: frame }) => {
    if (stopped || generator.readyState === 'ended') {
      frame?.close?.();
      return;
    }
    size.width = frame.displayWidth;
    size.height = frame.displayHeight;
    receivedFirstFrame();
    writer.write(frame).catch(() => frame.close());
  };
  window.postMessage('jump-native-capture-port', '*', [channel.port2]);

  try {
    const result = await desktop.startNativeCapture({ sourceId: source.id, displayId: source.displayId || '' });
    if (!result?.ok) throw new Error(`native-capture: ${result?.reason || 'failed'}`);
    size.width = result.width;
    size.height = result.height;
    let timer;
    await Promise.race([
      firstFrame,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native-capture: no-frames')), firstFrameTimeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    stopNative();
    generator.stop();
    throw error;
  }

  // The source went away (window closed): end the track like Chromium does so
  // the share stops through the usual `ended` handler.
  removeEndedListener = desktop.onNativeCaptureEnded?.(() => {
    stopNative();
    writer.close().catch(() => {});
  }) || (() => {});

  // Senders size their encodings from getSettings(); a generator track does not
  // report dimensions, so expose the captured size.
  const nativeGetSettings = generator.getSettings.bind(generator);
  generator.getSettings = () => ({
    ...nativeGetSettings(),
    width: size.width,
    height: size.height,
    frameRate: 60,
    displaySurface: String(source.id).startsWith('window:') ? 'window' : 'monitor',
  });
  const nativeStop = generator.stop.bind(generator);
  generator.stop = () => {
    stopNative();
    nativeStop();
  };
  return new MediaStream([generator]);
}
