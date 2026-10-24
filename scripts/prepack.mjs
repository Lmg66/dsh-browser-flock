import {spawnSync} from 'node:child_process';

// Run before npm/pnpm pack and publish; fail immediately on a failed check.
for (const args of [['scripts/build.mjs'], ['scripts/check.mjs'], ['--test']]) {
  const result = spawnSync(process.execPath, args, {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
