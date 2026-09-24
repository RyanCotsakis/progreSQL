import type { Action } from "../shared/actions";
import { primaryKeys, tableColumns } from "../shared/model";

export class ValidationError extends Error {}
export async function readData(db: D1Database) {
  const results = await db.batch([
    db.prepare("SELECT * FROM exercise ORDER BY exercise_name"),
    db.prepare("SELECT * FROM workout ORDER BY workout_name"),
    db.prepare(
      "SELECT * FROM exercise_settings_history ORDER BY effective_from",
    ),
    db.prepare("SELECT * FROM workout_exercise ORDER BY exercise_order"),
    db.prepare(
      "SELECT * FROM workout_session ORDER BY workout_date DESC, workout_session_id DESC",
    ),
  ]);
  return Object.fromEntries(
    ["exercises", "workouts", "prescriptions", "memberships", "sessions"].map(
      (key, i) => [key, results[i].results],
    ),
  );
}

export async function mutate(db: D1Database, a: Action) {
  const q = (sql: string, ...args: (string | number | null)[]) =>
    db.prepare(sql).bind(...args);
  switch (a.action) {
    case "exercise.create":
      await db.batch([
        q(
          "INSERT INTO exercise(exercise_name,muscle_group,equipment,description) VALUES (?,?,?,?)",
          a.name,
          a.muscle_group || null,
          a.equipment || null,
          a.description || null,
        ),
        q(
          `INSERT INTO exercise_settings_history(exercise_id,effective_from,weight,max_reps,sets,notes)
           VALUES (last_insert_rowid(),?,?,?,?,?)`,
          a.effective_from,
          a.weight,
          a.max_reps,
          a.sets,
          a.notes || null,
        ),
      ]);
      break;
    case "exercise.update":
      await q(
        "UPDATE exercise SET exercise_name=?,muscle_group=?,equipment=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE exercise_id=?",
        a.name,
        a.muscle_group || null,
        a.equipment || null,
        a.description || null,
        a.id,
      ).run();
      break;
    case "exercise.archive": {
      // The dependency check is inside the write, so simultaneous membership edits cannot race it.
      const result = await q(
        `UPDATE exercise SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE exercise_id=? AND NOT EXISTS (
        SELECT 1 FROM workout_exercise m JOIN workout w USING(workout_id)
        WHERE m.exercise_id=exercise.exercise_id AND m.effective_to IS NULL AND w.is_active=1)`,
        a.id,
      ).run();
      if (!result.meta.changes)
        throw new ValidationError(
          "Remove this exercise from its active workouts before archiving it.",
        );
      break;
    }
    case "exercise.state":
      // Insert and close the previous interval in ONE transaction. All boundaries are
      // computed inside SQL, never from a stale read in a different Worker request.
      await db.batch([
        q(
          `INSERT INTO exercise_settings_history(exercise_id,effective_from,effective_to,weight,max_reps,sets,notes)
          VALUES (?1,?2,CASE WHEN EXISTS (SELECT 1 FROM exercise_settings_history WHERE exercise_id=?1 AND effective_from<?2 AND (effective_to IS NULL OR effective_to>?2))
          THEN (SELECT effective_to FROM exercise_settings_history WHERE exercise_id=?1 AND effective_from<?2 AND (effective_to IS NULL OR effective_to>?2) ORDER BY effective_from DESC LIMIT 1)
          ELSE (SELECT MIN(effective_from) FROM exercise_settings_history WHERE exercise_id=?1 AND effective_from>?2) END,?3,?4,?5,?6)
          ON CONFLICT(exercise_id,effective_from) DO UPDATE SET weight=excluded.weight,max_reps=excluded.max_reps,sets=excluded.sets,notes=excluded.notes`,
          a.id,
          a.effective_from,
          a.weight,
          a.max_reps,
          a.sets,
          a.notes || null,
        ),
        q(
          `UPDATE exercise_settings_history SET effective_to=?2 WHERE exercise_id=?1 AND effective_from<?2 AND (effective_to IS NULL OR effective_to>?2)`,
          a.id,
          a.effective_from,
        ),
      ]);
      break;
    case "workout.create":
      await q(
        "INSERT INTO workout(workout_name,description) VALUES (?,?)",
        a.name,
        a.description || null,
      ).run();
      break;
    case "workout.update":
      await q(
        "UPDATE workout SET workout_name=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE workout_id=?",
        a.name,
        a.description || null,
        a.id,
      ).run();
      break;
    case "workout.archive":
      await q(
        "UPDATE workout SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE workout_id=?",
        a.id,
      ).run();
      break;
    case "workout.members":
      await db.batch([
        q(
          "DELETE FROM workout_exercise WHERE workout_id=? AND effective_from=?",
          a.id,
          a.effective_from,
        ),
        q(
          `UPDATE workout_exercise SET effective_to=?2 WHERE workout_id=?1 AND effective_from<?2 AND (effective_to IS NULL OR effective_to>?2)`,
          a.id,
          a.effective_from,
        ),
        q(
          `INSERT INTO workout_exercise(workout_id,exercise_id,exercise_order,effective_from,effective_to)
          SELECT ?1,value,CAST(key AS INTEGER)+1,?2,(SELECT MIN(effective_from) FROM workout_exercise WHERE workout_id=?1 AND effective_from>?2)
          FROM json_each(?3)`,
          a.id,
          a.effective_from,
          JSON.stringify(a.exercise_ids),
        ),
      ]);
      break;
    case "session.log":
      await q(
        "INSERT INTO workout_session(workout_id,workout_date,notes) VALUES (?,?,?)",
        a.id,
        a.workout_date,
        a.notes || null,
      ).run();
      break;
    case "session.delete": {
      const result = await q(
        "DELETE FROM workout_session WHERE workout_session_id=?",
        a.id,
      ).run();
      if (!result.meta.changes)
        throw new ValidationError("Workout session not found.");
      break;
    }
    case "admin.insert": {
      const columns = Object.keys(a.row);
      if (
        !columns.length ||
        columns.some((c) => !tableColumns[a.table].includes(c))
      )
        throw new ValidationError("Unknown or missing columns.");
      await q(
        `INSERT INTO ${a.table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        ...columns.map((c) => a.row[c]),
      ).run();
      break;
    }
    case "admin.save": {
      const pk = primaryKeys[a.table];
      const statements = a.deleted.map((id) =>
        q(`DELETE FROM ${a.table} WHERE ${pk}=?`, id),
      );
      for (const row of a.rows) {
        if (typeof row[pk] !== "number" || !Number.isSafeInteger(row[pk]))
          throw new ValidationError("Each row needs its original numeric ID.");
        const columns = Object.keys(row).filter((c) => c !== pk);
        if (
          !columns.length ||
          columns.some((c) => !tableColumns[a.table].includes(c))
        )
          throw new ValidationError("Unknown or missing columns.");
        statements.push(
          q(
            `UPDATE ${a.table} SET ${columns.map((c) => `${c}=?`).join(",")} WHERE ${pk}=?`,
            ...columns.map((c) => row[c]),
            row[pk],
          ),
        );
      }
      if (statements.length) await db.batch(statements);
      break;
    }
  }
}
