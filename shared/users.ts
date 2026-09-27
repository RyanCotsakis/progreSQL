import { z } from "zod";

export interface Identity {
  user_id: number;
  username: string;
  is_admin: number;
}
export interface UserSummary extends Identity {
  status: "pending" | "active" | "recovery";
  created_at: string;
}
export const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/,
    "Use letters, numbers, dots, @, underscores or hyphens.",
  );
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const proofSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const codeSchema = z.string().regex(/^\d{6}$/);
export const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const userActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), username: usernameSchema }),
  z.object({
    action: z.literal("update"),
    user_id: id,
    username: usernameSchema,
    is_admin: z.boolean(),
  }),
  z.object({
    action: z.literal("link"),
    user_id: id,
    kind: z.enum(["invite", "password", "recover"]),
  }),
  z.object({
    action: z.literal("delete"),
    user_id: id,
    confirmation: z.string(),
  }),
]);
export const adminRequestSchema = z.object({
  proof: proofSchema,
  code: codeSchema,
  operation: userActionSchema,
});
export const setupRequestSchema = z.object({ token: tokenSchema });
export const completeRequestSchema = z.object({
  token: tokenSchema,
  proof: proofSchema,
  code: codeSchema,
});
export type UserAction = z.infer<typeof userActionSchema>;
