import type Database from 'better-sqlite3';

const migrations = [
  `
    CREATE TABLE exams (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
      subject TEXT NOT NULL,
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX exams_by_status_subject ON exams (status, subject);
    CREATE INDEX exams_by_subject ON exams (subject);

    CREATE TABLE exam_questions (
      exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      question_json TEXT NOT NULL CHECK (json_valid(question_json)),
      PRIMARY KEY (exam_id, question_id),
      UNIQUE (exam_id, position)
    ) STRICT;

    CREATE TABLE exam_sessions (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL REFERENCES exams(id),
      status TEXT NOT NULL CHECK (status IN ('in_progress', 'pending_grading', 'graded')),
      snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
      auto_submit_on_timeout INTEGER NOT NULL CHECK (auto_submit_on_timeout IN (0, 1)),
      started_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      submitted_at INTEGER,
      submission_reason TEXT CHECK (submission_reason IN ('manual', 'timeout')),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    ) STRICT;
    CREATE INDEX exam_sessions_by_exam ON exam_sessions (exam_id);
    CREATE INDEX exam_sessions_due ON exam_sessions (deadline_at, id)
      WHERE status = 'in_progress' AND auto_submit_on_timeout = 1;

    CREATE TABLE session_responses (
      session_id TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, question_id)
    ) STRICT;

    CREATE TABLE session_flags (
      session_id TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      PRIMARY KEY (session_id, question_id)
    ) STRICT;

    CREATE TABLE exam_results (
      session_id TEXT PRIMARY KEY REFERENCES exam_sessions(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE question_grades (
      session_id TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      score REAL NOT NULL,
      feedback TEXT,
      PRIMARY KEY (session_id, question_id)
    ) STRICT;
  `,
];

export function migrate(db: Database.Database): void {
  db.transaction(() => {
    const version = db.prepare<[], { user_version: number }>('PRAGMA user_version').get()?.user_version;
    if (version === undefined || version < 0 || version > migrations.length) {
      throw new Error(`Unsupported Exam Runtime database version: ${String(version)}`);
    }
    for (const [index, sql] of migrations.entries()) {
      if (index < version) continue;
      db.exec(sql);
      db.pragma(`user_version = ${index + 1}`);
    }
  }).immediate();
}
