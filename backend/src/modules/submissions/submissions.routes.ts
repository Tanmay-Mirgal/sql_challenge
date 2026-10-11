import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import { Errors } from "@/utils/errors";
import { objectIdParam, ok, paginate, paginationMeta, paginationQuery } from "@/utils/http";
import { Submission } from "./submission.model";
import { toSubmissionDto } from "./submissions.service";

export function createSubmissionsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  /** A participant may only read their own submissions (administrators may read any). */
  router.get("/:submissionId", async (req, res) => {
    const id = objectIdParam.parse(req.params.submissionId);
    const submission = await Submission.findById(id);
    const user = req.auth!.user;
    if (!submission || (!submission.userId.equals(user._id) && user.role !== "admin")) {
      throw Errors.notFound("Submission not found.", "SUBMISSION_NOT_FOUND");
    }
    ok(res, { submission: toSubmissionDto(submission, { includeSql: true }) });
  });

  return router;
}

const mySubmissionsQuery = paginationQuery.extend({
  roundId: objectIdParam.optional(),
  challengeId: objectIdParam.optional(),
});

/** Mounted under /me. */
export function createMySubmissionsRouter(): Router {
  const router = Router();
  router.get("/submissions", requireAuth, async (req, res) => {
    const query = mySubmissionsQuery.parse(req.query);
    const filter: Record<string, unknown> = { userId: req.auth!.user._id };
    if (query.roundId) filter.roundId = query.roundId;
    if (query.challengeId) filter.challengeId = query.challengeId;
    const { skip, limit } = paginate(query);
    const [submissions, total] = await Promise.all([
      Submission.find(filter).sort({ submittedAt: -1 }).skip(skip).limit(limit),
      Submission.countDocuments(filter),
    ]);
    ok(res, { submissions: submissions.map((submission) => toSubmissionDto(submission)) }, paginationMeta(query, total));
  });
  return router;
}

