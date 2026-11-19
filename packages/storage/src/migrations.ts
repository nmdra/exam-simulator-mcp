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
  `
    ALTER TABLE exams ADD COLUMN agent_scope TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE exam_sessions ADD COLUMN agent_scope TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE exam_sessions ADD COLUMN current_question_id TEXT;
    ALTER TABLE exam_sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    UPDATE exam_sessions AS s SET updated_at = max(
      s.started_at,
      coalesce(s.submitted_at, s.started_at),
      coalesce((SELECT max(r.updated_at) FROM session_responses AS r WHERE r.session_id = s.id), s.started_at),
      coalesce((SELECT r.created_at FROM exam_results AS r WHERE r.session_id = s.id), s.started_at)
    );

    CREATE INDEX exams_by_scope ON exams (agent_scope, created_at DESC, id);
    CREATE INDEX exams_by_scope_status ON exams (agent_scope, status, created_at DESC, id);
    CREATE INDEX exams_by_scope_subject ON exams (agent_scope, subject, created_at DESC, id);

    CREATE TABLE agent_credentials (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE change_versions (
      key TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version > 0)
    ) STRICT;

    CREATE TABLE explanation_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      agent_scope TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('hint', 'detailed', 'why_wrong')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
      claim_owner TEXT,
      claim_hash TEXT,
      claim_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (id, session_id, question_id)
    ) STRICT;
    CREATE UNIQUE INDEX explanation_requests_equivalent
      ON explanation_requests (session_id, question_id, type)
      WHERE status IN ('pending', 'processing', 'completed');
    CREATE INDEX explanation_requests_by_scope
      ON explanation_requests (agent_scope, created_at, id);
    CREATE INDEX explanation_requests_by_scope_status
      ON explanation_requests (agent_scope, status, created_at, id);
    CREATE INDEX explanation_requests_by_session
      ON explanation_requests (session_id, created_at DESC, id);
    CREATE INDEX explanation_requests_expiring
      ON explanation_requests (claim_expires_at, id) WHERE status = 'processing';

    CREATE TABLE explanations (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      content_json TEXT NOT NULL CHECK (json_valid(content_json) AND json_type(content_json) = 'object'),
      completed_at INTEGER NOT NULL,
      FOREIGN KEY (request_id, session_id, question_id)
        REFERENCES explanation_requests (id, session_id, question_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX explanations_by_session ON explanations (session_id, completed_at DESC, id);
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
