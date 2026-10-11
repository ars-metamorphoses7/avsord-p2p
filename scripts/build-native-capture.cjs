// Builds native/bin/jump-capture.exe (Windows only) with the MSVC toolchain
// found through vswhere. Skips the build when the binary is newer than its
// source; pass --force to rebuild. Elsewhere it does nothing: the app falls
// back to Chromium's capturer when the helper is missing.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'capture', 'jump-capture.cpp');
const outputDir = path.join(root, 'native', 'bin');
const output = path.join(outputDir, 'jump-capture.exe');

if (process.platform !== 'win32') {
  console.log('[native] captura nativa só existe no Windows; nada a compilar.');
  process.exit(0);
}

const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
if (!process.argv.includes('--force') && mtime(output) > mtime(source)) {
  console.log('[native] jump-capture.exe já está atualizado.');
  process.exit(0);
}

const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
let installation = '';
try {
  installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
} catch { /* reported below */ }
const vcvars = installation && path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
if (!vcvars || !fs.existsSync(vcvars)) {
  console.error('[native] MSVC (Visual Studio Build Tools com C++) não encontrado; instale o workload "Desktop development with C++".');
  process.exit(1);
}

fs.mkdirSync(path.join(outputDir, 'obj'), { recursive: true });
const script = path.join(os.tmpdir(), `jump-native-${process.pid}.cmd`);
fs.writeFileSync(script, [
  '@echo off',
  // vcvars64 itself calls vswhere through PATH.
  `set "PATH=${path.dirname(vswhere)};%PATH%"`,
  `call "${vcvars}" >nul`,
  `cl /nologo /EHsc /std:c++20 /O2 /W3 /DUNICODE /D_UNICODE /DNOMINMAX "${source}" /Fo"${path.join(outputDir, 'obj')}\\\\" /Fe"${output}" /link d3d11.lib dxgi.lib windowsapp.lib user32.lib`,
].join('\r\n'));
try {
  execFileSync('cmd.exe', ['/d', '/c', script], { stdio: 'inherit', cwd: outputDir });
  console.log(`[native] ${path.relative(root, output)} compilado.`);
} finally {
  fs.rmSync(script, { force: true });
}
