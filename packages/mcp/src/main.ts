import process from 'node:process';
import { runMcp } from './index.js';

try {
  await runMcp();
} catch (error) {
  console.error('[exam-runtime MCP] Server failed:', error);
  process.exitCode = 1;
}
