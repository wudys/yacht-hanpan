import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the checked-in CI job; act copies the working tree while honoring .gitignore.
// Keep CPU pressure bounded and omit local environment, secret, variable and input files.
const result = spawnSync(
  'act',
  [
    'workflow_dispatch',
    '--workflows',
    '.github/workflows/ci.yml',
    '--job',
    'verify',
    '--platform',
    'ubuntu-24.04=catthehacker/ubuntu:act-24.04',
    '--container-architecture',
    'linux/amd64',
    '--container-options',
    '--cpus=2',
    '--container-daemon-socket=-',
    '--env-file',
    '/dev/null',
    '--secret-file',
    '/dev/null',
    '--var-file',
    '/dev/null',
    '--input-file',
    '/dev/null',
    '--use-gitignore=true',
    '--no-cache-server',
    '--rm',
  ],
  { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit' },
);

if (result.error) {
  console.error(
    result.error.code === 'ENOENT'
      ? 'Install act and start Docker (Docker Desktop or OrbStack), then run bun run ci:local.'
      : result.error.message,
  );
}
process.exit(result.status ?? 1);
