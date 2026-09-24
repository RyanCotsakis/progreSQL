import { describe, expect, it } from "vitest";
import { daysBetween, latestWorkouts, monthSessions } from "../shared/journal";
import type { WorkoutSession } from "../shared/model";
const session = (workout_id: number, workout_date: string): WorkoutSession => ({
  workout_id,
  workout_date,
  workout_session_id: workout_id,
  notes: null,
  created_at: workout_date,
});
describe("journal summaries", () => {
  it("includes every workout on the newest date regardless of input order", () => {
    expect(
      latestWorkouts(
        [
          session(3, "2026-09-20"),
          session(2, "2026-09-24"),
          session(1, "2026-09-24"),
          session(2, "2026-09-24"),
        ],
        "2026-09-25",
      ),
    ).toEqual({ date: "2026-09-24", daysAgo: 1, workoutIds: [1, 2] });
    expect(latestWorkouts([], "2026-09-25")).toBeNull();
  });
  it("counts calendar days across daylight-saving, leap day and year boundaries", () => {
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2026-09-25", "2026-09-25")).toBe(0);
    expect(daysBetween("2026-09-26", "2026-09-25")).toBe(-1);
  });
  it("limits month legends to logged workouts and preserves all workouts on a day", () => {
    const sessions = [
      session(1, "2026-01-31"),
      session(2, "2026-02-01"),
      session(3, "2026-02-01"),
      session(2, "2026-02-20"),
      session(4, "2025-02-01"),
    ];
    const february = monthSessions(sessions, "2026-02");
    expect(february.workoutIds).toEqual([2, 3]);
    expect([...february.byDay]).toEqual([
      ["2026-02-01", [2, 3]],
      ["2026-02-20", [2]],
    ]);
    expect(monthSessions(sessions, "2026-03").workoutIds).toEqual([]);
  });
});
