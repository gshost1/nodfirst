import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { company, employees, policies, routines } from './fixtures.mjs';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  const legacy = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='judgments'").get();
  if (legacy && !legacy.sql.includes('payroll')) {
    db.close();
    throw new Error(`${path} was created by an older version (v0.1) and cannot store the new decision fields. Use a new NODFIRST_DB path (the default is now .data/nodfirst.sqlite).`);
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, version TEXT NOT NULL, rule TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT NOT NULL,
      description TEXT NOT NULL, version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, location TEXT NOT NULL,
      startDate TEXT NOT NULL, manager TEXT NOT NULL,
      workMode TEXT NOT NULL CHECK(workMode IN ('remote','hybrid','office')),
      exception TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, employeeId TEXT NOT NULL UNIQUE REFERENCES employees(id),
      routineId TEXT NOT NULL REFERENCES routines(id),
      status TEXT NOT NULL CHECK(status IN ('active','complete')),
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, workflowId TEXT NOT NULL REFERENCES workflows(id),
      title TEXT NOT NULL, owner TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('todo','done','needs_judgment','awaiting_review','approved','rejected')),
      policyId TEXT NOT NULL REFERENCES policies(id),
      kind TEXT NOT NULL CHECK(kind IN ('checklist','exception')),
      details TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS judgments (
      id TEXT PRIMARY KEY, workflowId TEXT NOT NULL UNIQUE REFERENCES workflows(id),
      provider TEXT NOT NULL, model TEXT NOT NULL,
      route TEXT NOT NULL CHECK(route IN ('it','people_ops','payroll','security','uncertain')),
      confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1), reason TEXT NOT NULL,
      category TEXT, categoryConfidence REAL CHECK(categoryConfidence IS NULL OR categoryConfidence BETWEEN 0 AND 1),
      sensitive REAL CHECK(sensitive IS NULL OR sensitive BETWEEN 0 AND 1), probabilities TEXT,
      uncertain INTEGER NOT NULL CHECK(uncertain IN (0,1)), durationMs INTEGER NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, workflowId TEXT NOT NULL REFERENCES workflows(id),
      taskId TEXT NOT NULL UNIQUE REFERENCES tasks(id),
      judgmentId TEXT NOT NULL UNIQUE REFERENCES judgments(id),
      status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
      requestedAt TEXT NOT NULL, decidedAt TEXT, decidedBy TEXT, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY, approvalId TEXT NOT NULL UNIQUE REFERENCES approvals(id),
      workflowId TEXT NOT NULL REFERENCES workflows(id), type TEXT NOT NULL CHECK(type='local_task'),
      title TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL CHECK(status='created'), createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, workflowId TEXT NOT NULL UNIQUE REFERENCES workflows(id),
      type TEXT NOT NULL CHECK(type='judge_exception'),
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
      attempts INTEGER NOT NULL, error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, entityId TEXT NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, workflowId TEXT REFERENCES workflows(id), actor TEXT NOT NULL,
      action TEXT NOT NULL, details TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit entries are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit entries are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS action_requires_approval BEFORE INSERT ON actions
      WHEN NOT EXISTS (SELECT 1 FROM approvals WHERE id=NEW.approvalId AND status='approved' AND workflowId=NEW.workflowId)
      BEGIN SELECT RAISE(ABORT,'A matching approved decision is required'); END;
  `);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Internal table names and column names only; callers cannot supply SQL identifiers.
  function insert(table, record) {
    const keys = Object.keys(record);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(record));
    return record;
  }
  function get(table, key) { return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key); }
  function requireRecord(table, key) {
    const record = get(table, key);
    if (!record) throw new AppError(404, 'That record could not be found.');
    return record;
  }
  function log(actor, action, workflowId, details = {}, entityId = workflowId) {
    const timestamp = now();
    insert('audit', { id: id(), workflowId: workflowId || null, actor, action, details: JSON.stringify(details), createdAt: timestamp });
    insert('events', { id: id(), type: action, entityId: entityId || 'system', payload: JSON.stringify(details), createdAt: timestamp });
  }
  transaction(() => {
    for (const [table, records] of [['policies', policies], ['routines', routines], ['employees', employees]]) {
      for (const record of records) if (!get(table, record.id)) insert(table, record);
    }
  });
  function state() {
    const result = { company };
    for (const table of ['employees', 'policies', 'routines', 'workflows', 'tasks', 'judgments', 'approvals', 'actions', 'jobs', 'audit']) {
      result[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    }
    result.judgments = result.judgments.map(item => ({ ...item, uncertain: Boolean(item.uncertain), probabilities: item.probabilities ? JSON.parse(item.probabilities) : null }));
    result.audit = result.audit.map(item => ({ ...item, details: JSON.parse(item.details) })).reverse();
    return result;
  }
  function setting(key, value) {
    if (value === undefined) return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
    db.prepare('INSERT INTO settings (key,value,updatedAt) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt').run(key, value, now());
    return value;
  }
  return { db, transaction, insert, get, requireRecord, log, state, setting, close: () => db.close() };
}
