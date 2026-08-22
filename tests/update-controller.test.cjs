const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdateController } = require('../electron/update-controller.cjs');

class FakeUpdater extends EventEmitter {
  async checkForUpdates() {
    this.emit('checking-for-update');
    this.emit('update-available', { version: '2.0.0' });
  }

  async downloadUpdate() {
    this.emit('download-progress', { percent: 0.4, transferred: 4, total: 1000 });
    this.emit('download-progress', { percent: 72.2, transferred: 722, total: 1000 });
    this.emit('update-downloaded', { version: '2.0.0', downloadedFile: 'JUMP-2.0.0.exe' });
    return ['JUMP-2.0.0.exe'];
  }

  quitAndInstall(isSilent, forceRunAfter) {
    this.installArguments = [isSilent, forceRunAfter];
  }
}

test('does not replace available or downloaded events with stale IPC states', async () => {
  const updater = new FakeUpdater();
  const published = [];
  const scheduled = [];
  const controller = createUpdateController({
    autoUpdater: updater,
    isPackaged: true,
    sendState: (state) => published.push(state),
    scheduleInstall: (callback) => scheduled.push(callback),
  });

  const checked = await controller.check();
  assert.equal(checked.status, 'available');
  assert.equal(checked.version, '2.0.0');

  const downloaded = await controller.download();
  assert.equal(downloaded.status, 'downloaded');
  assert.equal(downloaded.percent, 100);
  assert.ok(published.some((state) => state.status === 'downloading' && state.percent === 72));
  assert.equal(published.at(-1).status, 'downloaded');

  const installing = controller.install();
  assert.equal(installing.status, 'installing');
  assert.equal(updater.autoRunAppAfterInstall, true);
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.deepEqual(updater.installArguments, [false, true]);
});

test('refuses to install before a completed download', () => {
  const updater = new FakeUpdater();
  const controller = createUpdateController({ autoUpdater: updater, isPackaged: true });
  const result = controller.install();
  assert.equal(result.status, 'error');
  assert.match(result.message, /ainda não terminou/i);
  assert.equal(updater.installArguments, undefined);
});
