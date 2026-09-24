CREATE TABLE exercise (
  exercise_id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise_name TEXT NOT NULL UNIQUE,
  muscle_group TEXT, equipment TEXT, description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE workout (
  workout_id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_name TEXT NOT NULL UNIQUE, description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE exercise_settings_history (
  exercise_settings_id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise_id INTEGER NOT NULL REFERENCES exercise(exercise_id) ON DELETE RESTRICT,
  effective_from TEXT NOT NULL, effective_to TEXT,
  weight NUMERIC NOT NULL CHECK (weight >= 0),
  max_reps INTEGER NOT NULL CHECK (max_reps > 0),
  sets INTEGER NOT NULL CHECK (sets > 0), notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (exercise_id, effective_from),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX ix_settings_exercise_period ON exercise_settings_history(exercise_id,effective_from,effective_to);
CREATE TABLE workout_exercise (
  workout_exercise_id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES workout(workout_id) ON DELETE CASCADE,
  exercise_id INTEGER NOT NULL REFERENCES exercise(exercise_id) ON DELETE RESTRICT,
  exercise_order INTEGER NOT NULL CHECK (exercise_order > 0),
  effective_from TEXT NOT NULL, effective_to TEXT,
  UNIQUE (workout_id,exercise_id,effective_from),
  UNIQUE (workout_id,exercise_order,effective_from),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX ix_workout_exercise_period ON workout_exercise(workout_id,effective_from,effective_to);
CREATE TABLE workout_session (
  workout_session_id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER NOT NULL REFERENCES workout(workout_id) ON DELETE RESTRICT,
  workout_date TEXT NOT NULL, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workout_id,workout_date)
);
CREATE INDEX ix_workout_session_date ON workout_session(workout_date);
