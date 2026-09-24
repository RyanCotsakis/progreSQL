import { z } from "zod";
import { tableNames } from "./model";

export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(value + "T00:00:00Z");
    return (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Choose a valid date.");
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const note = z.string().max(10000).nullable().optional();
const name = z.string().trim().min(1, "Enter a name.").max(120);
const meta = {
  name,
  muscle_group: z.string().max(80).optional(),
  equipment: z.string().max(80).optional(),
  description: note,
};
const state = {
  effective_from: day,
  weight: z.number().finite().min(0).max(99999.99),
  max_reps: z.number().int().positive(),
  sets: z.number().int().positive(),
  notes: note,
};
const row = z.record(
  z.string(),
  z.union([z.string(), z.number().finite(), z.null()]),
);
export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("exercise.create"), ...meta, ...state }),
  z.object({ action: z.literal("exercise.update"), id, ...meta }),
  z.object({ action: z.literal("exercise.archive"), id }),
  z.object({ action: z.literal("exercise.state"), id, ...state }),
  z.object({ action: z.literal("workout.create"), name, description: note }),
  z.object({
    action: z.literal("workout.update"),
    id,
    name,
    description: note,
  }),
  z.object({ action: z.literal("workout.archive"), id }),
  z.object({
    action: z.literal("workout.members"),
    id,
    effective_from: day,
    exercise_ids: z
      .array(id)
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each exercise only once.",
      ),
  }),
  z.object({
    action: z.literal("session.log"),
    id,
    workout_date: day,
    notes: note,
  }),
  z.object({ action: z.literal("session.delete"), id }),
  z
    .object({
      action: z.literal("admin.save"),
      table: z.enum(tableNames),
      rows: z.array(row).max(500),
      deleted: z.array(id).max(500),
    })
    .refine(
      (value) => value.rows.length + value.deleted.length <= 45,
      "Save at most 45 changed or deleted rows at a time.",
    ),
  z.object({
    action: z.literal("admin.insert"),
    table: z.enum(tableNames),
    row,
  }),
]);
export type Action = z.infer<typeof actionSchema>;
