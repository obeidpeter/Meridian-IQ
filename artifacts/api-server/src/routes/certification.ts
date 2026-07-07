import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb, cpdCoursesTable, cpdEnrollmentsTable, usersTable } from "@workspace/db";
import {
  ListCpdCoursesResponse,
  EnrollCpdCourseParams,
  EnrollCpdCourseResponse,
  CompleteCpdCourseParams,
  CompleteCpdCourseResponse,
  ListCpdEnrollmentsResponse,
} from "@workspace/api-zod";
import { assertCan, tenantFirmId } from "../modules/auth/rbac";
import { isFeatureEnabled } from "../modules/flags/flags";
import { DomainError } from "../modules/errors";
import { appendAudit } from "../modules/audit/audit";

// Certification portal with CPD content (CON-05). Courses are platform content;
// enrollments belong to the firm tenant; completing a course mints a
// certificate record with a verifiable serial. Gated by `white_label` (the
// certification portal ships as part of the channel-scale package).

const router: IRouter = Router();

async function gate(req: { principal: import("../modules/auth/rbac").Principal }): Promise<boolean> {
  return isFeatureEnabled("white_label", req.principal.firmId);
}

router.get("/certification/courses", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "certification.read");
  const rows = await getDb()
    .select()
    .from(cpdCoursesTable)
    .where(eq(cpdCoursesTable.active, true))
    .orderBy(asc(cpdCoursesTable.sortOrder));
  res.json(ListCpdCoursesResponse.parse(rows));
});

router.post(
  "/certification/courses/:id/enroll",
  async (req, res): Promise<void> => {
    if (!(await gate(req))) {
      res.sendStatus(404);
      return;
    }
    assertCan(req.principal, "certification.write");
    const firmId = tenantFirmId(req.principal);
    if (!firmId) {
      res.status(403).json({ error: "A firm-scoped principal is required" });
      return;
    }
    const params = EnrollCpdCourseParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [course] = await getDb()
      .select()
      .from(cpdCoursesTable)
      .where(
        and(eq(cpdCoursesTable.id, params.data.id), eq(cpdCoursesTable.active, true)),
      )
      .limit(1);
    if (!course) {
      res.status(404).json({ error: "Course not found" });
      return;
    }
    // Idempotent per (course, firm, user): re-enrolling returns the existing
    // row. The firm filter mirrors the unique constraint and the RLS scope.
    const [existing] = await getDb()
      .select()
      .from(cpdEnrollmentsTable)
      .where(
        and(
          eq(cpdEnrollmentsTable.courseId, course.id),
          eq(cpdEnrollmentsTable.firmId, firmId),
          eq(cpdEnrollmentsTable.userId, req.principal.userId),
        ),
      )
      .limit(1);
    if (existing) {
      res.status(201).json(EnrollCpdCourseResponse.parse(existing));
      return;
    }
    const [row] = await getDb()
      .insert(cpdEnrollmentsTable)
      .values({
        courseId: course.id,
        firmId,
        userId: req.principal.userId,
        status: "enrolled",
      })
      .returning();
    await appendAudit({
      actorId: req.principal.userId,
      firmId,
      action: "certification.enroll",
      entityType: "cpd_enrollment",
      entityId: row.id,
      after: { courseKey: course.key },
    });
    res.status(201).json(EnrollCpdCourseResponse.parse(row));
  },
);

router.post(
  "/certification/courses/:id/complete",
  async (req, res): Promise<void> => {
    if (!(await gate(req))) {
      res.sendStatus(404);
      return;
    }
    assertCan(req.principal, "certification.write");
    const firmId = tenantFirmId(req.principal);
    if (!firmId) {
      res.status(403).json({ error: "A firm-scoped principal is required" });
      return;
    }
    const params = CompleteCpdCourseParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [enrollment] = await getDb()
      .select()
      .from(cpdEnrollmentsTable)
      .where(
        and(
          eq(cpdEnrollmentsTable.courseId, params.data.id),
          eq(cpdEnrollmentsTable.firmId, firmId),
          eq(cpdEnrollmentsTable.userId, req.principal.userId),
        ),
      )
      .limit(1);
    if (!enrollment) {
      res.status(404).json({ error: "Not enrolled in this course" });
      return;
    }
    if (enrollment.status === "completed") {
      throw new DomainError("ALREADY_COMPLETED", "Course already completed", 409);
    }
    const completedAt = new Date();
    // Verifiable serial: deterministic over (enrollment, completion time) so a
    // certificate can be re-derived and checked against the record.
    const serial = `CPD-${createHash("sha256")
      .update(`${enrollment.id}:${completedAt.toISOString()}`)
      .digest("hex")
      .slice(0, 12)
      .toUpperCase()}`;
    const [row] = await getDb()
      .update(cpdEnrollmentsTable)
      .set({ status: "completed", completedAt, certificateSerial: serial })
      .where(eq(cpdEnrollmentsTable.id, enrollment.id))
      .returning();
    await appendAudit({
      actorId: req.principal.userId,
      firmId,
      action: "certification.complete",
      entityType: "cpd_enrollment",
      entityId: row.id,
      after: { certificateSerial: serial },
    });
    res.json(CompleteCpdCourseResponse.parse(row));
  },
);

router.get("/certification/enrollments", async (req, res): Promise<void> => {
  if (!(await gate(req))) {
    res.sendStatus(404);
    return;
  }
  assertCan(req.principal, "certification.read");
  const tenant = tenantFirmId(req.principal);
  const base = getDb()
    .select({
      id: cpdEnrollmentsTable.id,
      courseId: cpdEnrollmentsTable.courseId,
      courseTitle: cpdCoursesTable.title,
      cpdHours: cpdCoursesTable.cpdHours,
      userId: cpdEnrollmentsTable.userId,
      userName: usersTable.fullName,
      status: cpdEnrollmentsTable.status,
      completedAt: cpdEnrollmentsTable.completedAt,
      certificateSerial: cpdEnrollmentsTable.certificateSerial,
      createdAt: cpdEnrollmentsTable.createdAt,
    })
    .from(cpdEnrollmentsTable)
    .innerJoin(cpdCoursesTable, eq(cpdCoursesTable.id, cpdEnrollmentsTable.courseId))
    .leftJoin(usersTable, eq(usersTable.id, cpdEnrollmentsTable.userId));
  const rows = tenant
    ? await base.where(eq(cpdEnrollmentsTable.firmId, tenant))
    : await base;
  res.json(ListCpdEnrollmentsResponse.parse(rows));
});

export default router;
