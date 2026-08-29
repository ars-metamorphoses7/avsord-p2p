const fs = require('node:fs');
const path = require('node:path');

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const tag = String(process.env.JUMP_RELEASE_TAG || '').trim();
const expectedTag = `v${packageJson.version}`;

if (tag !== expectedTag) {
  process.stderr.write(`A tag ${tag || '(vazia)'} não corresponde à versão ${packageJson.version}. Esperado: ${expectedTag}.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Release version validada: ${tag}.\n`);
}
