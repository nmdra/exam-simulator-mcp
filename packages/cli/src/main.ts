#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, CommanderError, Option } from 'commander';
import {
  RuntimeError, checkExamUi, databasePath, openRuntime, runtimePort, sessionUiUrl, uiBaseUrl,
} from '@exam-runtime/core';
import type { ExamFilter, ExamRuntime, ExamSummary } from '@exam-runtime/core';

function withRuntime<T>(action: (runtime: ExamRuntime) => T): T {
  const runtime = openRuntime();
  try {
    return action(runtime);
  } finally {
    runtime.close();
  }
}

function examLine(exam: ExamSummary): string {
  return `${exam.id}  [${exam.status}]  ${exam.title} (${exam.subject}, ${exam.question_count} questions)`;
}

function writeLine(stream: NodeJS.WriteStream, line: string): void {
  stream.write(`${line}\n`);
}

function detailPath(path: (string | number)[]): string {
  let text = '';
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`;
    else text += text ? `.${segment}` : segment;
  }
  return text || '(input)';
}

function printError(error: unknown): void {
  if (error instanceof CommanderError) {
    // Commander writes its own errors and help before throwing.
    process.exitCode = error.exitCode;
    return;
  }
  process.exitCode = 1;
  if (error instanceof RuntimeError) {
    writeLine(process.stderr, `${error.code}: ${error.message}`);
    for (const detail of error.details) {
      writeLine(process.stderr, `  ${detailPath(detail.path)}: ${detail.message}`);
    }
    return;
  }
  writeLine(process.stderr, `Error: ${error instanceof Error ? error.message : String(error)}`);
}

async function serve(port: number): Promise<void> {
  const { serveRuntime } = await import('@exam-runtime/server');
  const runtime = openRuntime();
  const stop = Promise.withResolvers<void>();
  process.on('SIGINT', stop.resolve);
  process.on('SIGTERM', stop.resolve);
  try {
    const server = await serveRuntime(runtime, port);
    try {
      writeLine(process.stdout, `Exam Runtime listening at ${uiBaseUrl(port)}`);
      await stop.promise;
    } finally {
      await server.close();
    }
  } finally {
    process.off('SIGINT', stop.resolve);
    process.off('SIGTERM', stop.resolve);
    runtime.close();
  }
}

async function readExamFile(file: string): Promise<unknown> {
  const json = await readFile(file, 'utf8');
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new RuntimeError('VALIDATION', `Invalid JSON in ${file}.`, [{ path: [], message: error.message }]);
  }
}

function portOption(): Option {
  return new Option('--port <port>', 'Override EXAM_RUNTIME_PORT (default: 3000)');
}

const program = new Command()
  .name('exam-runtime')
  .description('Manage and take local exams.')
  .exitOverride();

program.command('init')
  .description('Initialize the local exam database.')
  .action(() => {
    const path = databasePath();
    withRuntime(() => undefined);
    writeLine(process.stdout, `Exam database ready: ${path}`);
  });

program.command('serve')
  .description('Serve the exam UI and API on 127.0.0.1.')
  .addOption(portOption())
  .action(async ({ port }: { port?: string }) => {
    await serve(runtimePort(port));
  });

program.command('mcp')
  .description('Run the MCP server over stdin and stdout.')
  .action(async () => {
    const { runMcp } = await import('@exam-runtime/mcp');
    await runMcp();
  });

const exam = program.command('exam').description('Manage exams and start attempts.');

exam.command('import <file>')
  .description('Import a JSON exam definition as a draft.')
  .action(async (file: string) => {
    const definition = await readExamFile(file);
    const imported = withRuntime((runtime) => runtime.createExam(definition));
    writeLine(process.stdout, `Imported ${examLine(imported)}`);
  });

exam.command('list')
  .description('List local exams.')
  .addOption(new Option('--status <status>', 'Filter by exam status').choices(['draft', 'published']))
  .option('--subject <subject>', 'Filter by subject')
  .action(({ status, subject }: ExamFilter) => {
    const exams = withRuntime((runtime) => runtime.listExams({ status, subject: subject?.trim() }));
    if (exams.length === 0) writeLine(process.stdout, 'No exams found.');
    for (const entry of exams) writeLine(process.stdout, examLine(entry));
  });

exam.command('show <id>')
  .description('Print the full exam record as JSON, including answer keys (trusted use only).')
  .action((id: string) => {
    const record = withRuntime((runtime) => runtime.getExam(id));
    writeLine(process.stdout, JSON.stringify(record, null, 2));
  });

exam.command('publish <id>')
  .description('Publish a draft exam so candidates can start it.')
  .action((id: string) => {
    const published = withRuntime((runtime) => runtime.publishExam(id));
    writeLine(process.stdout, `Published ${examLine(published)}`);
  });

exam.command('start <id>')
  .description('Start an attempt immediately and print its URL.')
  .addOption(portOption())
  .action(async (id: string, { port: optionPort }: { port?: string }) => {
    const port = runtimePort(optionPort);
    const session = withRuntime((runtime) => runtime.startSession(id));
    writeLine(process.stdout, sessionUiUrl(session.id, port));
    const ui = await checkExamUi(id, port);
    if (!ui.available) writeLine(process.stderr, `Warning: ${ui.message}`);
  });

program.command('results <session-id>')
  .description('Show the attempt status or score.')
  .action((id: string) => {
    const view = withRuntime((runtime) => runtime.getResults(id, false));
    if (view.status === 'graded') {
      const { passed, percent, earned_points, maximum_points, passing_percent, level } = view.result;
      const score = `${percent}% (${earned_points}/${maximum_points} points)`;
      writeLine(process.stdout, `${view.title}: ${passed ? 'Passed' : 'Failed'} with ${score}. Passing score: ${passing_percent}%.`);
      if (level) writeLine(process.stdout, `Level: ${level}`);
    } else if (view.status === 'pending_grading') {
      writeLine(process.stdout, `${view.title}: Pending grading.`);
    } else {
      writeLine(process.stdout, `${view.title}: In progress. No results yet.`);
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  printError(error);
}
