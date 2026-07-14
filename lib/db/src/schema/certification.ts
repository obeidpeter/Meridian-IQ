import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { firmsTable, usersTable } from "./organizations.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Certification portal with CPD content (CON-05). Deliberately minimal: courses
// are platform content (seeded, operator-managed), enrollments are per firm
// user, and a completion mints a certificate record with a verifiable serial.

export const cpdCoursesTable = pgTable("cpd_courses", {
  id: id(),
  key: text("key").notNull().unique(),
  title: text("title").notNull(),
  summary: text("summary"),
  // CPD credit hours awarded on completion.
  cpdHours: integer("cpd_hours").notNull().default(1),
  // Ordered module titles/content refs rendered by the portal.
  modules: jsonb("modules").$type<{ title: string; body: string }[]>(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cpdEnrollmentStatusEnum = pgEnum("cpd_enrollment_status", [
  "enrolled",
  "completed",
]);

export const cpdEnrollmentsTable = pgTable(
  "cpd_enrollments",
  {
    id: id(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => cpdCoursesTable.id),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    status: cpdEnrollmentStatusEnum("status").notNull().default("enrolled"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Verifiable certificate serial minted on completion.
    certificateSerial: text("certificate_serial"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Firm-scoped uniqueness: enrollments (and their RLS) are per firm, and a
  // user holding memberships in two firms earns CPD in each independently. A
  // global (courseId, userId) unique would 500 on the second firm's enroll —
  // its RLS-scoped existence check cannot see the first firm's row.
  (t) => [unique().on(t.courseId, t.firmId, t.userId)],
);

export type CpdCourse = typeof cpdCoursesTable.$inferSelect;
export type CpdEnrollment = typeof cpdEnrollmentsTable.$inferSelect;
