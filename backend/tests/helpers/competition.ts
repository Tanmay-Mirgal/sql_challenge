import { Types } from "mongoose";
import { expect } from "vitest";
import type { ChallengeContentInput } from "@/modules/challenges/challenge.schema";
import { EventModel } from "@/modules/events/event.model";
import { Round } from "@/modules/rounds/round.model";
import { Submission } from "@/modules/submissions/submission.model";
import { setClock } from "@/utils/clock";
import { collegeSchema, sampleRows } from "./sample-data";
import { type TestClient } from "./test-app";
import type { DatasetRows } from "@/modules/sql-execution/types";

/** Fixed, controllable "server time" for deterministic scoring tests. */
export const T0 = new Date("2030-03-01T10:00:00.000Z");
let offsetMs = 0;
export function useFakeClock(): void {
  offsetMs = 0;
  setClock(() => new Date(T0.getTime() + offsetMs));
}
export function advanceTo(minutesAfterStart: number): void {
  offsetMs = minutesAfterStart * 60_000;
}
export function releaseClock(): void {
  setClock(undefined);
}

/** Dataset helper: start from the sample and replace whole tables. */
export const variant = (overrides: DatasetRows): DatasetRows => ({ ...sampleRows, ...overrides });

const hiddenStudents = (rows: Array<[number, string, number | null, string | null, number, number | null, string | null]>) => rows;

// ---- Round 1 (basic): students aged 21 or over, alphabetical -------------------------------------
export const round1Content = (): ChallengeContentInput => ({
  title: "The Suspicious Sign-ups",
  narrative:
    "Registration for the Spring Fest closed last night, but the head of the committee noticed a pile of sign-ups that look unusual. You have been given read access to the student table to start the investigation.",
  problemStatement: "List every student who is at least 21 years old so the committee can double-check their paperwork first.",
  taskDescription: "Return one column named `name` with the names of students aged 21 or older, sorted alphabetically (A to Z).",
  difficulty: "basic",
  concepts: ["SELECT", "WHERE", "ORDER BY"],
  dialect: "postgresql",
  schema: collegeSchema,
  publicSamples: [{ name: "Sample", description: "The committee's current records.", rows: sampleRows }],
  candidateTestCases: [
    {
      category: "boundary",
      description: "21-year-olds around the boundary",
      rows: variant({
        students: hiddenStudents([
          [1, "Mira", 1, "mira@college.edu", 21, 3.1, "2023-01-01"],
          [2, "Noor", 1, null, 20, 3.0, "2023-01-02"],
          [3, "Omar", 2, "omar@college.edu", 22, 2.5, "2023-01-03"],
          [4, "Pia", 2, "pia@college.edu", 21, 3.9, null],
        ]),
        registrations: [],
      }),
    },
    {
      category: "empty_result",
      description: "everybody is younger than 21",
      rows: variant({
        students: hiddenStudents([
          [1, "Quin", 1, "q@college.edu", 18, 3.3, "2024-01-01"],
          [2, "Rae", 2, null, 20, 2.8, "2024-01-02"],
        ]),
        registrations: [],
      }),
    },
    {
      category: "nulls",
      description: "NULL emails and gpas must not matter",
      rows: variant({
        students: hiddenStudents([
          [1, "Sam", null, null, 30, null, null],
          [2, "Tara", 1, null, 21, null, "2022-05-05"],
          [3, "Uma", 3, "uma@college.edu", 19, 3.5, "2024-06-06"],
        ]),
        registrations: [],
      }),
    },
  ],
  starterSql: "-- Which students are 21 or older?\nSELECT name\nFROM students\n",
  hints: ["Filter rows with WHERE.", "Remember the boundary: 'at least 21' includes 21."],
  constraints: ["Return exactly one column."],
  solutionSql: "SELECT name FROM students WHERE age >= 21 ORDER BY name",
  comparisonPolicy: { ordered: true, matchColumnNames: false },
  explanation: "A simple filter plus ordering.",
  storySummary: "The committee found a batch of suspicious sign-ups and asked you to check the older students first.",
});

// ---- Round 2 (intermediate): departments with more than one student -----------------------------
export const round2Content = (): ChallengeContentInput => ({
  title: "Duplicate Departments",
  narrative:
    "The older students check out, but the committee spotted that some departments have unusually many sign-ups. Next you must compare the departments against the student list to see where the numbers come from.",
  problemStatement: "Find the departments that have more than one student, and how many students each has.",
  taskDescription:
    "Return `department` (department name) and `students` (number of students), only for departments with more than one student, ordered by `students` descending then `department` ascending.",
  difficulty: "intermediate",
  concepts: ["JOIN", "GROUP BY", "HAVING"],
  dialect: "postgresql",
  schema: collegeSchema,
  publicSamples: [{ name: "Sample", description: "Current records.", rows: sampleRows }],
  candidateTestCases: [
    {
      category: "aggregation",
      description: "a three-student department",
      rows: variant({
        students: hiddenStudents([
          [1, "Vik", 1, "v@college.edu", 20, 3.1, "2023-01-01"],
          [2, "Wes", 1, null, 21, 3.0, "2023-01-02"],
          [3, "Xia", 1, "x@college.edu", 22, 2.5, "2023-01-03"],
          [4, "Yan", 2, "y@college.edu", 21, 3.9, null],
          [5, "Zoe", 3, "z@college.edu", 21, 3.9, null],
        ]),
        registrations: [],
      }),
    },
    {
      category: "boundary",
      description: "exactly one student per department",
      rows: variant({
        students: hiddenStudents([
          [1, "Abe", 1, "a@college.edu", 20, 3.1, "2023-01-01"],
          [2, "Bea", 2, null, 21, 3.0, "2023-01-02"],
          [3, "Cal", 3, "c@college.edu", 22, 2.5, "2023-01-03"],
        ]),
        registrations: [],
      }),
    },
    {
      category: "nulls",
      description: "students with no department must not form a group",
      rows: variant({
        students: hiddenStudents([
          [1, "Dee", null, null, 20, null, null],
          [2, "Eve", null, null, 21, null, null],
          [3, "Fay", 2, "f@college.edu", 22, 2.5, "2023-01-03"],
          [4, "Gus", 2, null, 22, 2.5, "2023-01-03"],
        ]),
        registrations: [],
      }),
    },
  ],
  starterSql: "SELECT d.name AS department\nFROM departments d\n",
  hints: ["Join students to departments.", "Use HAVING to filter groups."],
  constraints: [],
  solutionSql:
    "SELECT d.name AS department, COUNT(s.id) AS students FROM departments d JOIN students s ON s.dept_id = d.id GROUP BY d.name HAVING COUNT(s.id) > 1 ORDER BY students DESC, department",
  comparisonPolicy: { ordered: true, matchColumnNames: false },
  explanation: "Join, group, filter groups.",
  storySummary: "Departments with multiple sign-ups were flagged; the trail now points to the event registrations.",
});

// ---- Round 3 (advanced): CTE + CASE + JOIN -----------------------------------------------------
export const round3Content = (): ChallengeContentInput => ({
  title: "The Final Report",
  narrative:
    "With the registration records matched to departments, the committee needs a final report: which events actually had people attending, and which were mostly no-shows? Compile it from the registration records.",
  problemStatement: "Classify every event that has registrations as 'high' or 'low' attendance.",
  taskDescription:
    "Return `title` and `attendance`. An event is 'high' when at least half of its registrations have status 'attended', otherwise 'low'. Only include events with at least one registration. Order by title.",
  difficulty: "advanced",
  concepts: ["CTE", "CASE", "JOIN", "conditional aggregation"],
  dialect: "postgresql",
  schema: collegeSchema,
  publicSamples: [{ name: "Sample", description: "Current records.", rows: sampleRows }],
  candidateTestCases: [
    {
      category: "boundary",
      description: "exactly half attended",
      rows: variant({
        events: [[1, "Alpha", 10], [2, "Beta", 10], [3, "Gamma", 10]],
        registrations: [
          [1, 1, 1, "attended", null],
          [2, 2, 1, "no_show", null],
          [3, 1, 2, "no_show", null],
          [4, 2, 2, "no_show", null],
          [5, 3, 2, "no_show", null],
        ],
      }),
    },
    {
      category: "empty_result",
      description: "no registrations at all",
      rows: variant({ registrations: [] }),
    },
    {
      category: "multiple_matches",
      description: "all attended",
      rows: variant({
        events: [[1, "Delta", 10], [2, "Echo", 10]],
        registrations: [
          [1, 1, 1, "attended", null],
          [2, 2, 1, "attended", null],
          [3, 3, 2, "attended", null],
        ],
      }),
    },
  ],
  starterSql: "WITH attendance AS (\n  -- count attended vs total registrations per event\n)\nSELECT 1;",
  hints: ["A CTE can pre-compute counts per event."],
  constraints: [],
  solutionSql:
    "WITH att AS (SELECT event_id, SUM(CASE WHEN status = 'attended' THEN 1 ELSE 0 END) AS attended, COUNT(*) AS total FROM registrations GROUP BY event_id) SELECT e.title, CASE WHEN att.attended * 2 >= att.total THEN 'high' ELSE 'low' END AS attendance FROM events e JOIN att ON att.event_id = e.id ORDER BY e.title",
  comparisonPolicy: { ordered: true, matchColumnNames: false },
  explanation: "CTE with conditional aggregation then CASE.",
  storySummary: "The final report shows which events were genuinely attended.",
});

export const CORRECT = {
  1: "SELECT name FROM students WHERE age >= 21 ORDER BY name",
  2: round2Content().solutionSql,
  3: round3Content().solutionSql,
} as const;

/** Creates an event whose three rounds each have one validated, published challenge. */
export async function setupPublishedCompetition(admin: TestClient, options: { scoring?: object; topN?: [number, number]; draftOnly?: boolean } = {}) {
  const create = await admin.post("/api/v1/admin/events", {
    name: `Acceptance Cup ${new Types.ObjectId().toString().slice(-5)}`,
    scoring: { maxScorePerChallenge: 100, fullCorrectnessBonus: 10, timePenaltyIntervalSeconds: 60, timePenaltyPoints: 2, maxTimePenalty: 30, ...options.scoring },
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const eventId = create.body.data.event.id as string;
  const rounds = await Round.find({ eventId }).sort({ number: 1 });
  const contents = [round1Content(), round2Content(), round3Content()];
  const challengeIds: string[] = [];
  for (const [index, round] of rounds.entries()) {
    const authored = await admin.post(`/api/v1/admin/rounds/${round.id}/challenges`, contents[index]);
    expect(authored.status, JSON.stringify(authored.body)).toBe(201);
    challengeIds.push(authored.body.data.challenge.id as string);
  }
  const [topN1, topN2] = options.topN ?? [20, 10];
  const windows = [
    { startsAt: new Date(T0.getTime()), endsAt: new Date(T0.getTime() + 2 * 3_600_000) },
    { startsAt: new Date(T0.getTime() + 3 * 3_600_000), endsAt: new Date(T0.getTime() + 5 * 3_600_000) },
    { startsAt: new Date(T0.getTime() + 6 * 3_600_000), endsAt: new Date(T0.getTime() + 8 * 3_600_000) },
  ];
  for (const [index, round] of rounds.entries()) {
    const patch: Record<string, unknown> = { ...windows[index], storyChapter: "" };
    if (index === 0) patch.qualification = { topN: topN1 };
    if (index === 1) patch.qualification = { topN: topN2 };
    const updated = await admin.patch(`/api/v1/admin/rounds/${round.id}`, patch);
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  }
  if (!options.draftOnly) {
    for (const id of challengeIds) {
      const published = await admin.post(`/api/v1/admin/challenges/${id}/publish`);
      expect(published.status, JSON.stringify(published.body)).toBe(200);
    }
    for (const round of rounds) expect((await admin.post(`/api/v1/admin/rounds/${round.id}/actions`, { action: "schedule" })).status).toBe(200);
  }
  return { eventId, rounds: rounds.map((r) => r.id as string), challengeIds };
}

export async function goLive(admin: TestClient, eventId: string): Promise<void> {
  expect((await admin.post(`/api/v1/admin/events/${eventId}/transition`, { to: "registration" })).status).toBe(200);
}

/** Inserts an already-scored submission (bypasses SQL) to build large leaderboards quickly. */
export async function insertScoredSubmission(params: {
  userId: Types.ObjectId;
  eventId: string;
  roundId: string;
  roundNumber: number;
  challengeId: string;
  lineageId: Types.ObjectId;
  score: number;
  at: Date;
  verdict?: "accepted" | "partial";
  counted?: boolean;
}) {
  return Submission.create({
    userId: params.userId,
    eventId: params.eventId,
    roundId: params.roundId,
    roundNumber: params.roundNumber,
    challengeId: params.challengeId,
    lineageId: params.lineageId,
    challengeVersion: 1,
    sql: "SELECT 1",
    sqlHash: "x",
    status: "completed",
    verdict: params.verdict ?? "accepted",
    passedTests: 4,
    totalTests: 4,
    score: params.score,
    counted: params.counted ?? true,
    idempotencyKey: new Types.ObjectId().toString(),
    submittedAt: params.at,
    evaluatedAt: params.at,
    testResults: [],
  });
}

export { EventModel };
