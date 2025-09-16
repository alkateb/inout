PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE -- e.g., 'Famous People', 'Animals', 'Cars', 'Food', 'Sweets', 'Fruits', 'Vegetables'
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(subject_id, value),
  FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

-- cumulative scores across rooms (by player nickname)
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  UNIQUE(nickname)
);

-- seed a few subjects
INSERT OR IGNORE INTO subjects (name) VALUES
('Famous People'), ('Animals'), ('Cars'), ('Food'), ('Sweets'), ('Fruits'), ('Vegetables');

-- some starter items (you can add more via Admin UI)
INSERT OR IGNORE INTO items (subject_id, value)
SELECT s.id, v.value FROM subjects s
JOIN (
  VALUES
  ('Famous People','Michael Jackson'),
  ('Famous People','Albert Einstein'),
  ('Famous People','Rihanna'),
  ('Animals','Elephant'),
  ('Animals','Penguin'),
  ('Cars','Toyota Corolla'),
  ('Cars','Ferrari'),
  ('Food','Pizza'),
  ('Sweets','Baklava'),
  ('Fruits','Mango'),
  ('Vegetables','Carrot')
) AS v(sub,value)
ON s.name = v.sub
;
