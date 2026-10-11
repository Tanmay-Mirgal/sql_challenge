import { z } from "zod";

/** Mirrors the API's profile schema; the server re-validates everything. */
export const profileSchema = z.object({
  rollNumber: z
    .string()
    .trim()
    .max(40, "Keep it under 40 characters.")
    .regex(/^$|^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/, "Use letters, digits, spaces, '.', '/', '_' or '-'."),
  department: z.string().trim().max(100, "Keep it under 100 characters."),
});

export type ProfileFormValues = z.infer<typeof profileSchema>;
