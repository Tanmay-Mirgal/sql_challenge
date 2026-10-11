import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable();

/** Only these fields can ever be changed by a participant. Unknown keys (e.g. `role`) are rejected. */
export const updateProfileSchema = z.strictObject({
  rollNumber: optionalText(40)
    .refine((value) => value === null || /^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/.test(value), "Roll number contains invalid characters.")
    .optional(),
  department: optionalText(100).optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
