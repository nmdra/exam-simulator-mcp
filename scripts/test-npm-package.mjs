import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import manifest from '../package.json' with { type: 'json' };

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run test:npm-package after npm run pack:npm.');
const archive = resolve(process.argv[2] ?? `dist/npm/exam-runtime-mcp-${manifest.version}.tgz`);
const cwd = await mkdtemp(join(tmpdir(), 'exam-runtime-package-test-'));
const client = new Client({ name: 'exam-runtime-package-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [npm, 'exec', '--yes', `--package=${archive}`, '--', 'exam-runtime', 'mcp'],
  cwd,
  env: { EXAM_RUNTIME_DB_PATH: join(cwd, 'smoke.sqlite3') },
  stderr: 'inherit',
});

try {
  await client.connect(transport, { timeout: 60_000 });
  assert.equal(client.getServerVersion()?.version, manifest.version);
  const response = await client.callTool({ name: 'exam_list_sessions', arguments: {} }, { timeout: 5_000 });
  assert.deepEqual(response.structuredContent, { data: [] });
  console.log('Packaged MCP server opened SQLite and answered over stdio outside the workspace.');
} finally {
  try { await client.close(); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}
