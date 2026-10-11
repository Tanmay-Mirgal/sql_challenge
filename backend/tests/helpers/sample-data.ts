import { buildConfig } from "@/config";
import { parseEnv } from "@/config/env";
import { schemaSpecSchema } from "@/modules/sql-execution/fixtures";
import { SqlExecutionService } from "@/modules/sql-execution/service";
import type { DatasetRows, SchemaSpec } from "@/modules/sql-execution/types";

export function createSqlService(overrides: Partial<ReturnType<typeof buildConfig>["sql"]> = {}): SqlExecutionService {
  const config = buildConfig(parseEnv());
  return SqlExecutionService.create({ ...config.sql, ...overrides });
}

/** A small college-events schema used across the SQL, scoring and end-to-end tests. */
export const collegeSchema: SchemaSpec = schemaSpecSchema.parse({
  tables: [
    {
      name: "departments",
      description: "Academic departments.",
      columns: [
        { name: "id", type: "integer", nullable: false, primaryKey: true },
        { name: "name", type: "varchar(50)", nullable: false },
      ],
    },
    {
      name: "students",
      description: "Registered students.",
      columns: [
        { name: "id", type: "integer", nullable: false, primaryKey: true },
        { name: "name", type: "varchar(60)", nullable: false },
        { name: "dept_id", type: "integer", nullable: true, references: { table: "departments", column: "id" } },
        { name: "email", type: "varchar(100)", nullable: true },
        { name: "age", type: "integer", nullable: false },
        { name: "gpa", type: "numeric(3,2)", nullable: true },
        { name: "joined_on", type: "date", nullable: true },
      ],
    },
    {
      name: "events",
      description: "Campus events.",
      columns: [
        { name: "id", type: "integer", nullable: false, primaryKey: true },
        { name: "title", type: "varchar(80)", nullable: false },
        { name: "capacity", type: "integer", nullable: false },
      ],
    },
    {
      name: "registrations",
      description: "Which student registered for which event.",
      columns: [
        { name: "id", type: "integer", nullable: false, primaryKey: true },
        { name: "student_id", type: "integer", nullable: false, references: { table: "students", column: "id" } },
        { name: "event_id", type: "integer", nullable: false, references: { table: "events", column: "id" } },
        { name: "status", type: "varchar(20)", nullable: false },
        { name: "registered_at", type: "timestamp", nullable: true },
      ],
    },
  ],
});

export const sampleRows: DatasetRows = {
  departments: [
    [1, "Computer Engineering"],
    [2, "Information Technology"],
    [3, "Mechanical"],
  ],
  students: [
    [1, "Asha", 1, "asha@college.edu", 20, 3.8, "2023-07-01"],
    [2, "Bilal", 1, null, 21, 3.1, "2023-07-02"],
    [3, "Chen", 2, "chen@college.edu", 19, null, "2024-01-15"],
    [4, "Divya", 2, "divya@college.edu", 22, 3.55, null],
    [5, "Eli", null, "eli@college.edu", 20, 2.9, "2024-02-01"],
  ],
  events: [
    [1, "SQL Cup", 100],
    [2, "Hack Night", 50],
    [3, "Quiet Quiz", 10],
  ],
  registrations: [
    [1, 1, 1, "attended", "2024-03-01 10:00:00"],
    [2, 1, 2, "attended", "2024-03-02 11:30:00"],
    [3, 2, 1, "no_show", "2024-03-01 10:05:00"],
    [4, 3, 1, "attended", null],
    [5, 3, 2, "attended", "2024-03-02 09:15:30"],
    [6, 4, 1, "attended", "2024-03-01 10:10:00"],
  ],
};

/** A second dataset with the same schema but different content (for isolation tests). */
export const otherRows: DatasetRows = {
  departments: [[1, "Physics"]],
  students: [[1, "Zed", 1, "zed@college.edu", 30, 4.0, "2020-01-01"]],
  events: [[1, "Secret Event", 5]],
  registrations: [[1, 1, 1, "attended", "2024-04-01 00:00:00"]],
};
