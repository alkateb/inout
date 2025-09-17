PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(subject_id, value),
  FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  UNIQUE(nickname)
);

INSERT OR IGNORE INTO subjects (name) VALUES
('Famous People'), ('Animals'), ('Cars'), ('Food'), ('Sweets'), ('Fruits'), ('Vegetables');
