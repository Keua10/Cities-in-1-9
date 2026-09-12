import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
// Pin the completed STEP 4.8 + city generator baseline for the visual-polish change.
// An explicit override can still inspect historical references.
const baseline = process.env.PARITY_BASELINE ?? 'a73d9d4';
mkdirSync('.check', { recursive: true });
async function run(original) {
  const output = resolve('.check', `refactor-parity-${original ? 'baseline' : 'current'}.mjs`);
  await build({
    entryPoints: ['tools/check/refactorScenario.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { 'pixi.js': resolve('tools/check/stub-pixi.ts') },
    plugins: original
      ? [
          {
            name: 'baseline-sources',
            setup(b) {
              b.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, (args) => ({
                contents: execFileSync(
                  'git',
                  [
                    'show',
                    baseline + ':' + relative(resolve('.'), args.path).replaceAll('\\', '/'),
                  ],
                  { encoding: 'utf8' },
                ),
                resolveDir: dirname(args.path),
                loader: 'ts',
              }));
            },
          },
        ]
      : [],
  });
  const started = performance.now();
  const result = (await import(pathToFileURL(output).href)).default;
  console.log(
    `${original ? 'baseline' : 'current'} scenario ${Math.round(performance.now() - started)}ms`,
  );
  writeFileSync(output + '.json', JSON.stringify(result));
  return result;
}
assert.deepEqual(await run(false), await run(true));
console.log(
  `PASS configuration exports, 60-day macro history, assignments and saved tile layers match ${baseline}`,
);
