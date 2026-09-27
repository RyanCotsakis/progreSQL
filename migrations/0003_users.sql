-- Stage all copies before dropping old tables: ON DELETE actions still run
-- when foreign key checks are deferred in D1.
CREATE TABLE users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','recovery')),
  password_parameters TEXT,
  password_verifier TEXT,
  totp_secret TEXT,
  credential_version INTEGER NOT NULL DEFAULT 1,
  last_totp_step INTEGER NOT NULL DEFAULT -1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO users(user_id,username,is_admin) VALUES(1,'__bootstrap__',1);
CREATE TABLE exercise_new (
  exercise_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  exercise_name TEXT NOT NULL,
  muscle_group TEXT, equipment TEXT, description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,exercise_name), UNIQUE(user_id,exercise_id)
);
CREATE TABLE workout_new (
  workout_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  workout_name TEXT NOT NULL, description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,workout_name), UNIQUE(user_id,workout_id)
);
CREATE TABLE exercise_settings_history_new (
  exercise_settings_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  exercise_id INTEGER NOT NULL,
  effective_from TEXT NOT NULL, effective_to TEXT,
  weight NUMERIC NOT NULL CHECK(weight>=0),
  max_reps INTEGER NOT NULL CHECK(max_reps>0),
  sets INTEGER NOT NULL CHECK(sets>0), notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id,exercise_id) REFERENCES exercise_new(user_id,exercise_id) ON DELETE RESTRICT,
  UNIQUE(exercise_id,effective_from),
  CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE TABLE workout_exercise_new (
  workout_exercise_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  workout_id INTEGER NOT NULL, exercise_id INTEGER NOT NULL,
  exercise_order INTEGER NOT NULL CHECK(exercise_order>0),
  effective_from TEXT NOT NULL, effective_to TEXT,
  FOREIGN KEY(user_id,workout_id) REFERENCES workout_new(user_id,workout_id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,exercise_id) REFERENCES exercise_new(user_id,exercise_id) ON DELETE RESTRICT,
  UNIQUE(workout_id,exercise_id,effective_from), UNIQUE(workout_id,exercise_order,effective_from),
  CHECK(effective_to IS NULL OR effective_to>effective_from)
);
CREATE TABLE workout_session_new (
  workout_session_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  workout_id INTEGER NOT NULL, workout_date TEXT NOT NULL, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id,workout_id) REFERENCES workout_new(user_id,workout_id) ON DELETE RESTRICT,
  UNIQUE(workout_id,workout_date)
);
INSERT INTO exercise_new SELECT exercise_id,1,exercise_name,muscle_group,equipment,description,is_active,created_at,updated_at FROM exercise;
INSERT INTO workout_new SELECT workout_id,1,workout_name,description,is_active,created_at,updated_at FROM workout;
INSERT INTO exercise_settings_history_new SELECT exercise_settings_id,1,exercise_id,effective_from,effective_to,weight,max_reps,sets,notes,created_at FROM exercise_settings_history;
INSERT INTO workout_exercise_new SELECT workout_exercise_id,1,workout_id,exercise_id,exercise_order,effective_from,effective_to FROM workout_exercise;
INSERT INTO workout_session_new SELECT workout_session_id,1,workout_id,workout_date,notes,created_at FROM workout_session;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='exercise'),0)) WHERE name='exercise_new';
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='workout'),0)) WHERE name='workout_new';
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='exercise_settings_history'),0)) WHERE name='exercise_settings_history_new';
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='workout_exercise'),0)) WHERE name='workout_exercise_new';
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='workout_session'),0)) WHERE name='workout_session_new';
DROP TABLE workout_session;
DROP TABLE workout_exercise;
DROP TABLE exercise_settings_history;
DROP TABLE workout;
DROP TABLE exercise;
ALTER TABLE exercise_new RENAME TO exercise;
ALTER TABLE workout_new RENAME TO workout;
ALTER TABLE exercise_settings_history_new RENAME TO exercise_settings_history;
ALTER TABLE workout_exercise_new RENAME TO workout_exercise;
ALTER TABLE workout_session_new RENAME TO workout_session;
CREATE INDEX ix_settings_owner_period ON exercise_settings_history(user_id,exercise_id,effective_from,effective_to);
CREATE INDEX ix_members_owner_period ON workout_exercise(user_id,workout_id,effective_from,effective_to);
CREATE INDEX ix_sessions_owner_date ON workout_session(user_id,workout_date);
DROP TABLE auth_session;
DROP TABLE auth_totp;
CREATE TABLE auth_session (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ix_auth_session_user ON auth_session(user_id);
CREATE INDEX ix_auth_session_expiry ON auth_session(expires_at);
CREATE TABLE auth_token (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('invite','password','recover')),
  expires_at INTEGER NOT NULL,
  password_parameters TEXT NOT NULL,
  totp_secret TEXT,
  consumed_nonce TEXT
);
CREATE TABLE auth_bootstrap (id INTEGER PRIMARY KEY CHECK(id=1));
