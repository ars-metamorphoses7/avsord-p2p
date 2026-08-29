const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const packagePath = path.join(projectRoot, 'package.json');
const metadataPath = path.join(projectRoot, 'electron', 'build-metadata.json');

function stableVersion(value) {
  const version = String(value || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Versão de release inválida: ${version || '(vazia)'}.`);
  return version;
}

function buildCommit() {
  const provided = String(process.env.JUMP_BUILD_COMMIT || process.env.GITHUB_SHA || '').trim();
  const commit = provided || execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error('Commit de build inválido.');
  return commit;
}

async function main() {
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const metadata = {
    version: stableVersion(packageJson.version),
    commit: buildCommit(),
    builtAt: new Date().toISOString(),
  };
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  process.stdout.write(`Build metadata: ${metadata.version} ${metadata.commit}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
