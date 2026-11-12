import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(
  testDirectory,
  '..',
  '.github',
  'workflows',
  'deploy.yml',
);
const flagPattern = /RUN_[A-Z0-9_]+_E2E_TESTS/g;

/** Each e2e suite only runs when its own RUN_*_E2E_TESTS variable is 'true'. */
function flagsUsedByE2eSuites(): string[] {
  const flags = new Set<string>();
  for (const file of readdirSync(testDirectory)) {
    if (!file.endsWith('.e2e-spec.ts')) continue;
    const source = readFileSync(join(testDirectory, file), 'utf8');
    for (const flag of source.match(flagPattern) ?? []) flags.add(flag);
  }
  return [...flags].sort();
}

describe('CI e2e configuration', () => {
  it('enables every RUN_*_E2E_TESTS flag used by an e2e suite in the CI job', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const enabled = new Set(
      [
        ...workflow.matchAll(
          /^\s*(RUN_[A-Z0-9_]+_E2E_TESTS):\s*['"]?true['"]?\s*$/gm,
        ),
      ].map((match) => match[1]),
    );

    const missing = flagsUsedByE2eSuites().filter((flag) => !enabled.has(flag));

    // A missing flag means that suite is silently skipped in CI.
    expect(missing).toEqual([]);
  });
});
