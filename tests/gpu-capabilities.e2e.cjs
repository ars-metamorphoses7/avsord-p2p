const { app } = require('electron');

async function run() {
  await app.whenReady();
  await Promise.race([
    new Promise((resolve) => app.once('gpu-info-update', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_500)),
  ]);
  const features = app.getGPUFeatureStatus();
  const info = await app.getGPUInfo('basic');
  const activeGpu = info?.gpuDevice?.find((device) => device.active) || info?.gpuDevice?.[0] || null;
  const result = {
    hardwareAcceleration: app.isHardwareAccelerationEnabled(),
    videoEncode: features.video_encode || 'unknown',
    gpuCompositing: features.gpu_compositing || 'unknown',
    activeGpu,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.hardwareAcceleration) throw new Error('A aceleração de hardware do Electron está desativada.');
}

run().then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
