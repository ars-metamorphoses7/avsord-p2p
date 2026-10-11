const fs = require('node:fs/promises');
const path = require('node:path');

const STREAM_LOG_MAX_BYTES = 4 * 1024 * 1024;
const STREAM_LOG_MAX_LINES = 64;
const STREAM_LOG_MAX_LINE_LENGTH = 800;

function localTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Appends timestamped lines to a small rotating text file (current + `.1`).
function createStreamLogWriter({ filePath, header = '', fsApi = fs, now = () => new Date(), maxBytes = STREAM_LOG_MAX_BYTES }) {
  let queue = Promise.resolve();
  let headerWritten = !header;
  const append = (lines) => {
    queue = queue.then(async () => {
      await fsApi.mkdir(path.dirname(filePath), { recursive: true });
      const size = await fsApi.stat(filePath).then((stat) => stat.size, () => 0);
      if (size > maxBytes) await fsApi.rename(filePath, `${filePath}.1`).catch(() => {});
      const stamp = localTimestamp(now());
      const body = [...(headerWritten ? [] : [header]), ...lines].map((line) => `${stamp} ${line}`).join('\n');
      headerWritten = true;
      await fsApi.appendFile(filePath, `${body}\n`, 'utf8');
    }).catch(() => {});
    return queue;
  };
  return { append, filePath };
}

function sanitizeStreamLogLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, STREAM_LOG_MAX_LINES)
    .filter((line) => typeof line === 'string')
    .map((line) => line.replace(/[\r\n]+/g, ' ').slice(0, STREAM_LOG_MAX_LINE_LENGTH));
}

function setupStreamLog({ app, ipcMain }) {
  const filePath = path.join(app.getPath('userData'), 'diagnostics', 'stream-log.txt');
  const writer = createStreamLogWriter({
    filePath,
    header: `--- JUMP ${app.getVersion()} ${process.platform} (${process.versions.chrome})`,
  });
  ipcMain.handle('stream-log:append', async (_event, lines) => {
    const clean = sanitizeStreamLogLines(lines);
    if (clean.length) await writer.append(clean);
    return { ok: true };
  });
  return writer;
}

module.exports = { createStreamLogWriter, sanitizeStreamLogLines, setupStreamLog };
