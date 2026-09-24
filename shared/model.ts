export interface Exercise {
  exercise_id: number;
  exercise_name: string;
  muscle_group: string | null;
  equipment: string | null;
  description: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}
export interface Workout {
  workout_id: number;
  workout_name: string;
  description: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}
export interface Prescription {
  exercise_settings_id: number;
  exercise_id: number;
  effective_from: string;
  effective_to: string | null;
  weight: number;
  max_reps: number;
  sets: number;
  notes: string | null;
  created_at: string;
}
export interface Membership {
  workout_exercise_id: number;
  workout_id: number;
  exercise_id: number;
  exercise_order: number;
  effective_from: string;
  effective_to: string | null;
}
export interface WorkoutSession {
  workout_session_id: number;
  workout_id: number;
  workout_date: string;
  notes: string | null;
  created_at: string;
}
export interface AppData {
  exercises: Exercise[];
  workouts: Workout[];
  prescriptions: Prescription[];
  memberships: Membership[];
  sessions: WorkoutSession[];
}
export const tableNames = [
  "exercise",
  "workout",
  "exercise_settings_history",
  "workout_exercise",
  "workout_session",
] as const;
export type TableName = (typeof tableNames)[number];
export const primaryKeys: Record<TableName, string> = {
  exercise: "exercise_id",
  workout: "workout_id",
  exercise_settings_history: "exercise_settings_id",
  workout_exercise: "workout_exercise_id",
  workout_session: "workout_session_id",
};
export const tableColumns: Record<TableName, string[]> = {
  exercise: [
    "exercise_id",
    "exercise_name",
    "muscle_group",
    "equipment",
    "description",
    "is_active",
    "created_at",
    "updated_at",
  ],
  workout: [
    "workout_id",
    "workout_name",
    "description",
    "is_active",
    "created_at",
    "updated_at",
  ],
  exercise_settings_history: [
    "exercise_settings_id",
    "exercise_id",
    "effective_from",
    "effective_to",
    "weight",
    "max_reps",
    "sets",
    "notes",
    "created_at",
  ],
  workout_exercise: [
    "workout_exercise_id",
    "workout_id",
    "exercise_id",
    "exercise_order",
    "effective_from",
    "effective_to",
  ],
  workout_session: [
    "workout_session_id",
    "workout_id",
    "workout_date",
    "notes",
    "created_at",
  ],
};
export function applies(
  row: { effective_from: string; effective_to: string | null },
  day: string,
) {
  return (
    row.effective_from <= day && (!row.effective_to || day < row.effective_to)
  );
}
export function stateFor(data: AppData, exerciseId: number, day: string) {
  return data.prescriptions
    .filter((p) => p.exercise_id === exerciseId && applies(p, day))
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
}
export function membersFor(data: AppData, workoutId: number, day: string) {
  return data.memberships
    .filter((m) => m.workout_id === workoutId && applies(m, day))
    .sort((a, b) => a.exercise_order - b.exercise_order);
}
export function localDay(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
