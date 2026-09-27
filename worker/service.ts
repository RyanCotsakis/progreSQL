import type { Identity } from "../shared/users";
import { AuthError } from "./auth";
import type { Action } from "../shared/actions";
import { primaryKeys, tableColumns } from "../shared/model";

export class ValidationError extends Error {}
export async function readData(db: D1Database, user: Identity, all = false) {
  if (all && !user.is_admin) throw new AuthError("Admin access required.", 403);
  const scope = all ? "" : ` WHERE user_id=${user.user_id}`;
  const results = await db.batch([
    db.prepare(`SELECT * FROM exercise${scope} ORDER BY exercise_name`),
    db.prepare(`SELECT * FROM workout${scope} ORDER BY workout_name`),
    db.prepare(
      `SELECT * FROM exercise_settings_history${scope} ORDER BY effective_from`,
    ),
    db.prepare(
      `SELECT * FROM workout_exercise${scope} ORDER BY exercise_order`,
    ),
    db.prepare(
      `SELECT * FROM workout_session${scope} ORDER BY workout_date DESC, workout_session_id DESC`,
    ),
  ]);
  return Object.fromEntries(
    ["exercises", "workouts", "prescriptions", "memberships", "sessions"].map(
      (key, i) => [key, results[i].results],
    ),
  );
}

export async function mutate(db: D1Database, a: Action, user: Identity) {
  const q = (sql: string, ...args: (string | number | null)[]) =>
    db.prepare(sql).bind(...args);
  if (a.action.startsWith("admin.")) {
    if (!user.is_admin) throw new AuthError("Admin access required.", 403);
  } else if ("id" in a) {
    const table = a.action.startsWith("exercise.")
      ? "exercise"
      : a.action === "session.delete"
        ? "workout_session"
        : "workout";
    const pk = primaryKeys[table];
    if (
      !(await q(
        `SELECT 1 FROM ${table} WHERE ${pk}=? AND user_id=?`,
        a.id,
        user.user_id,
      ).first())
    )
      throw new AuthError("Record not found.", 404);
    if (a.action === "workout.members") {
      const rows = await q(
        "SELECT exercise_id FROM exercise WHERE user_id=? AND exercise_id IN (SELECT value FROM json_each(?))",
        user.user_id,
        JSON.stringify(a.exercise_ids),
      ).all();
      if (rows.results.length !== a.exercise_ids.length)
        throw new AuthError("Record not found.", 404);
    }
  }
  switch (a.action) {
    case "exercise.create":
      await db.batch([
        q(
          `INSERT INTO exercise(user_id,exercise_name,muscle_group,equipment,description) VALUES (${user.user_id},?,?,?,?)`,
          a.name,
          a.muscle_group || null,
          a.equipment || null,
          a.description || null,
        ),
        q(
          `INSERT INTO exercise_settings_history(user_id,exercise_id,effective_from,weight,max_reps,sets,notes)
           VALUES (${user.user_id},last_insert_rowid(),?,?,?,?,?)`,
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
        `UPDATE exercise SET exercise_name=?,muscle_group=?,equipment=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=${user.user_id} AND exercise_id=?`,
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
        `UPDATE exercise SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE user_id=${user.user_id} AND exercise_id=? AND NOT EXISTS (
        SELECT 1 FROM workout_exercise m JOIN workout w USING(workout_id)
        WHERE m.user_id=${user.user_id} AND m.exercise_id=exercise.exercise_id AND m.effective_to IS NULL AND w.is_active=1)`,
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
          `INSERT INTO exercise_settings_history(user_id,exercise_id,effective_from,effective_to,weight,max_reps,sets,notes)
          VALUES (${user.user_id},?1,?2,CASE WHEN EXISTS (SELECT 1 FROM exercise_settings_history WHERE user_id=${user.user_id} AND exercise_id=?1 AND effective_from<?2 AND (effective_to IS NULL OR effective_to>?2))
          THEN (SELECT effective_to FROM exercise_settings_history WHERE user_id=${user.user_id} AND exercise_id=?1 AND effective_from<?2 AND (effective_to IS NULL OR effective_to>?2) ORDER BY effective_from DESC LIMIT 1)
          ELSE (SELECT MIN(effective_from) FROM exercise_settings_history WHERE user_id=${user.user_id} AND exercise_id=?1 AND effective_from>?2) END,?3,?4,?5,?6)
          ON CONFLICT(exercise_id,effective_from) DO UPDATE SET weight=excluded.weight,max_reps=excluded.max_reps,sets=excluded.sets,notes=excluded.notes WHERE exercise_settings_history.user_id=${user.user_id}`,
          a.id,
          a.effective_from,
          a.weight,
          a.max_reps,
          a.sets,
          a.notes || null,
        ),
        q(
          `UPDATE exercise_settings_history SET effective_to=?2 WHERE user_id=${user.user_id} AND exercise_id=?1 AND effective_from<?2 AND (effective_to IS NULL OR effective_to>?2)`,
          a.id,
          a.effective_from,
        ),
      ]);
      break;
    case "workout.create":
      await q(
        `INSERT INTO workout(user_id,workout_name,description) VALUES (${user.user_id},?,?)`,
        a.name,
        a.description || null,
      ).run();
      break;
    case "workout.update":
      await q(
        `UPDATE workout SET workout_name=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=${user.user_id} AND workout_id=?`,
        a.name,
        a.description || null,
        a.id,
      ).run();
      break;
    case "workout.archive":
      await q(
        `UPDATE workout SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE user_id=${user.user_id} AND workout_id=?`,
        a.id,
      ).run();
      break;
    case "workout.members":
      await db.batch([
        q(
          `DELETE FROM workout_exercise WHERE user_id=${user.user_id} AND workout_id=? AND effective_from=?`,
          a.id,
          a.effective_from,
        ),
        q(
          `UPDATE workout_exercise SET effective_to=?2 WHERE user_id=${user.user_id} AND workout_id=?1 AND effective_from<?2 AND (effective_to IS NULL OR effective_to>?2)`,
          a.id,
          a.effective_from,
        ),
        q(
          `INSERT INTO workout_exercise(user_id,workout_id,exercise_id,exercise_order,effective_from,effective_to)
          SELECT ${user.user_id},?1,value,CAST(key AS INTEGER)+1,?2,(SELECT MIN(effective_from) FROM workout_exercise WHERE user_id=${user.user_id} AND workout_id=?1 AND effective_from>?2)
          FROM json_each(?3)`,
          a.id,
          a.effective_from,
          JSON.stringify(a.exercise_ids),
        ),
      ]);
      break;
    case "session.log":
      await q(
        `INSERT INTO workout_session(user_id,workout_id,workout_date,notes) VALUES (${user.user_id},?,?,?)`,
        a.id,
        a.workout_date,
        a.notes || null,
      ).run();
      break;
    case "session.delete": {
      const result = await q(
        `DELETE FROM workout_session WHERE user_id=${user.user_id} AND workout_session_id=?`,
        a.id,
      ).run();
      if (!result.meta.changes)
        throw new ValidationError("Workout session not found.");
      break;
    }
    case "admin.insert": {
      if (!Number.isSafeInteger(a.row.user_id) || Number(a.row.user_id) <= 0)
        throw new ValidationError("Choose an owner (user_id).");
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
      const existingRows = await q(
        `SELECT ${pk},user_id FROM ${a.table} WHERE ${pk} IN (SELECT value FROM json_each(?))`,
        JSON.stringify(a.rows.map((row) => row[pk])),
      ).all<Record<string, number>>();
      const owners = new Map(
        existingRows.results.map((row) => [row[pk], row.user_id]),
      );
      const statements = a.deleted.map((id) =>
        q(`DELETE FROM ${a.table} WHERE ${pk}=?`, id),
      );
      for (const row of a.rows) {
        if (typeof row[pk] !== "number" || !Number.isSafeInteger(row[pk]))
          throw new ValidationError("Each row needs its original numeric ID.");
        const owner = owners.get(row[pk]);
        if (owner === undefined) throw new AuthError("Record not found.", 404);
        if ("user_id" in row && row.user_id !== owner)
          throw new ValidationError("Record ownership cannot be changed.");
        const columns = Object.keys(row).filter(
          (c) => c !== pk && c !== "user_id",
        );
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
