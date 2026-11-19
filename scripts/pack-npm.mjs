import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const repository = fileURLToPath(new URL('../', import.meta.url));
const releaseDir = join(repository, 'dist', 'npm');
const packageDirs = ['cli', 'core', 'mcp', 'schemas', 'server', 'storage'];
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run pack:npm to build and pack the distribution.');

async function readJson(file) {
  const source = await readFile(join(repository, file), 'utf8');
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new Error(`Invalid package manifest: ${file}`, { cause });
  }
}

const root = await readJson('package.json');
const workspaces = await Promise.all(packageDirs.map((name) => readJson(`packages/${name}/package.json`)));
const localNames = new Set(workspaces.map(({ name }) => name));
const dependencies = {};
for (const workspace of workspaces) {
  for (const [name, version] of Object.entries(workspace.dependencies ?? {})) {
    if (localNames.has(name)) continue;
    if (Object.hasOwn(dependencies, name) && dependencies[name] !== version) {
      throw new Error(`Runtime workspaces use incompatible versions of ${name}.`);
    }
    dependencies[name] = version;
  }
}

const externalNames = Object.keys(dependencies);
const stage = await mkdtemp(join(tmpdir(), 'exam-runtime-npm-'));
try {
  const bundle = await rolldown({
    cwd: repository,
    input: join(repository, 'packages/cli/dist/main.js'),
    platform: 'node',
    // Resolve the private workspaces into the bundle. Leave installed runtime
    // packages external, especially better-sqlite3 and its native bindings.
    external: (id) => externalNames.some((name) => id === name || id.startsWith(`${name}/`)),
    onLog(level, log, handler) {
      if (log.code === 'UNRESOLVED_IMPORT') handler('error', log);
      else handler(level, log);
    },
  });
  try {
    // Keep the existing CLI and server layout. The server resolves the UI from
    // import.meta.url, so its chunk must be at the same depth as the entry.
    await bundle.write({
      dir: join(stage, 'packages/cli/dist'), format: 'esm',
      entryFileNames: 'main.js', chunkFileNames: '[name]-[hash].js',
    });
  } finally {
    await bundle.close();
  }

  const launcher = 'packages/cli/bin/exam-runtime.js';
  const files = [launcher, 'apps/web/dist', 'README.md', 'docs/ai-agent-integration.md',
    'docs/runtime-reference.md', 'docs/releasing.md', 'examples/aws-practice.json', 'examples/practice-assistance.json'];
  await Promise.all(files.map((path) => cp(join(repository, path), join(stage, path), { recursive: true })));
  await chmod(join(stage, launcher), 0o755);
  const manifest = {
    name: 'exam-runtime-mcp',
    version: root.version,
    description: 'Local certification exam practice with a browser UI and an MCP stdio server',
    type: 'module',
    repository: root.repository,
    engines: root.engines,
    bin: { 'exam-runtime': `./${launcher}` },
    files: ['packages/cli/dist', ...files],
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(releaseDir, { recursive: true });
  execFileSync(process.execPath, [npm, 'pack', '--pack-destination', releaseDir], { cwd: stage, stdio: 'inherit' });
} finally {
  await rm(stage, { recursive: true, force: true });
}
