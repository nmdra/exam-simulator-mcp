# Changelog

Notable changes to Exam Runtime are listed here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/).

## [Unreleased]

### Added

- Let agents find recent attempts in their own scope with `exam_list_sessions` instead of asking the candidate for a session ID
- Build a tested npm tarball and publish it automatically when a stable release tag is pushed

### Changed

- Document how to create a practice set, review the submitted results, and tailor the next quiz to the candidate's weakest topics

## [0.1.0] - 2026-11-19

### Added

- Run timed practice in a local browser with SQLite persistence, answer-key grading, and agent grading
- Deliver scoped exam state and explanation updates over MCP and show approved explanations in the browser

[Unreleased]: https://github.com/nmdra/exam-simulator-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nmdra/exam-simulator-mcp/releases/tag/v0.1.0
