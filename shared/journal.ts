import type { WorkoutSession } from "./model";

// UTC calendar dates avoid 23/25-hour daylight-saving days changing the count.
export function daysBetween(earlier: string, later: string) {
  return Math.round(
    (Date.parse(later + "T00:00:00Z") - Date.parse(earlier + "T00:00:00Z")) /
      86400000,
  );
}

export function latestWorkouts(sessions: WorkoutSession[], today: string) {
  const date = sessions.reduce(
    (latest, session) =>
      session.workout_date > latest ? session.workout_date : latest,
    "",
  );
  if (!date) return null;
  return {
    date,
    daysAgo: daysBetween(date, today),
    workoutIds: [
      ...new Set(
        sessions
          .filter((s) => s.workout_date === date)
          .map((s) => s.workout_id),
      ),
    ].sort((a, b) => a - b),
  };
}

export function monthSessions(sessions: WorkoutSession[], month: string) {
  const byDay = new Map<string, number[]>();
  for (const session of sessions) {
    if (!session.workout_date.startsWith(month + "-")) continue;
    const ids = byDay.get(session.workout_date) || [];
    if (!ids.includes(session.workout_id)) ids.push(session.workout_id);
    byDay.set(
      session.workout_date,
      ids.sort((a, b) => a - b),
    );
  }
  return {
    byDay,
    workoutIds: [...new Set([...byDay.values()].flat())].sort((a, b) => a - b),
  };
}

// IDs keep colours stable when navigating months or renaming/archiving workouts.
export function workoutColour(id: number) {
  const palette = [
    "#176b4f",
    "#2563eb",
    "#b45309",
    "#9333ea",
    "#be185d",
    "#0e7490",
    "#c2410c",
    "#4d7c0f",
  ];
  return palette[id - 1] || `hsl(${(id * 137.508) % 360} 65% 38%)`;
}
