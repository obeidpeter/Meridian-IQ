import { useState } from "react";
import {
  useGetMe,
  useListCpdCourses,
  useListCpdEnrollments,
  useEnrollCpdCourse,
  useCompleteCpdCourse,
  getListCpdEnrollmentsQueryKey,
} from "@workspace/api-client-react";
import type { CpdCourse, CpdEnrollmentView } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { isFeatureDisabled } from "@/lib/errors";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  Award,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Clock,
  GraduationCap,
} from "lucide-react";
import {
  formatDate,
  enrollmentBadgeClasses,
  enrollmentLabel,
} from "@/lib/format";

function CourseCard({
  course,
  enrollment,
  onEnroll,
  onComplete,
  busy,
}: {
  course: CpdCourse;
  enrollment: CpdEnrollmentView | undefined;
  onEnroll: () => void;
  onComplete: () => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const modules = course.modules ?? [];

  return (
    <Card data-testid={`card-course-${course.key}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-start justify-between gap-2">
          <span className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
            {course.title}
          </span>
          <span className="text-xs font-normal text-muted-foreground flex items-center gap-1 whitespace-nowrap">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
            {course.cpdHours} CPD hr{course.cpdHours === 1 ? "" : "s"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {course.summary && (
          <p className="text-sm text-muted-foreground">{course.summary}</p>
        )}
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-medium text-primary rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          data-testid={`button-modules-${course.key}`}
        >
          {expanded ? (
            <ChevronUp className="w-4 h-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="w-4 h-4" aria-hidden="true" />
          )}
          {modules.length} module{modules.length === 1 ? "" : "s"}
        </button>
        {expanded && modules.length > 0 && (
          <div className="space-y-2">
            {modules.map((m, i) => (
              <div key={i} className="border rounded-md p-3">
                <p className="text-sm font-medium">
                  {i + 1}. {m.title}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{m.body}</p>
              </div>
            ))}
          </div>
        )}

        {enrollment?.status === "completed" ? (
          <div
            className="flex items-center gap-2 border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 rounded-md px-3 py-2"
            data-testid={`text-certificate-${course.key}`}
          >
            <Award className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs text-emerald-800 dark:text-emerald-300">
                Completed {formatDate(enrollment.completedAt)}
              </p>
              <p className="text-sm font-mono font-semibold text-emerald-900 dark:text-emerald-200 break-all">
                {enrollment.certificateSerial}
              </p>
            </div>
          </div>
        ) : enrollment ? (
          <Button
            size="sm"
            onClick={onComplete}
            disabled={busy}
            data-testid={`button-complete-${course.key}`}
          >
            <Award className="w-4 h-4 mr-1" aria-hidden="true" />
            {busy ? "Completing…" : "Mark complete"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={onEnroll}
            disabled={busy}
            data-testid={`button-enroll-${course.key}`}
          >
            <GraduationCap className="w-4 h-4 mr-1" aria-hidden="true" />
            {busy ? "Enrolling…" : "Enroll"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function Certification() {
  usePageTitle("Certification");
  const { data: me } = useGetMe();
  const {
    data: courses,
    isLoading: coursesLoading,
    error: coursesError,
    refetch: refetchCourses,
  } = useListCpdCourses();
  const {
    data: enrollments,
    isLoading: enrollmentsLoading,
    error: enrollmentsError,
    refetch: refetchEnrollments,
  } = useListCpdEnrollments();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const enroll = useEnrollCpdCourse();
  const complete = useCompleteCpdCourse();

  const [lastCertificate, setLastCertificate] = useState<{
    courseTitle: string;
    serial: string;
  } | null>(null);
  // Only the card whose action fired disables (§7) — not every sibling.
  const [pendingCourseId, setPendingCourseId] = useState<string | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: getListCpdEnrollmentsQueryKey(),
    });

  const handleEnroll = (course: CpdCourse) => {
    setPendingCourseId(course.id);
    enroll.mutate(
      { id: course.id },
      {
        onSuccess: () => {
          toast({ title: `Enrolled in ${course.title}` });
          refresh();
        },
        onError: () =>
          toast({ title: "Could not enroll", variant: "destructive" }),
        onSettled: () => setPendingCourseId(null),
      },
    );
  };

  const handleComplete = (course: CpdCourse) => {
    setPendingCourseId(course.id);
    complete.mutate(
      { id: course.id },
      {
        onSuccess: (res) => {
          if (res.certificateSerial) {
            setLastCertificate({
              courseTitle: course.title,
              serial: res.certificateSerial,
            });
          }
          toast({
            title: "Course completed",
            description: res.certificateSerial
              ? `Certificate ${res.certificateSerial}`
              : undefined,
          });
          refresh();
        },
        onError: () =>
          toast({
            title: "Could not mark complete",
            variant: "destructive",
          }),
        onSettled: () => setPendingCourseId(null),
      },
    );
  };

  if (coursesLoading || enrollmentsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (isFeatureDisabled(coursesError) || isFeatureDisabled(enrollmentsError)) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Certification
        </h1>
        <FeatureUnavailable feature="The certification portal" />
      </div>
    );
  }

  if (coursesError || enrollmentsError || !courses) {
    return (
      <div className="space-y-6">
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Certification
        </h1>
        <QueryError
          thing="certification courses"
          onRetry={() => {
            refetchCourses();
            refetchEnrollments();
          }}
        />
      </div>
    );
  }

  const enrollmentByCourse = new Map(
    (enrollments ?? [])
      .filter((e) => e.userId === me?.userId)
      .map((e) => [e.courseId, e] as const),
  );


  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Certification
        </h1>
        <p className="text-muted-foreground mt-1">
          CPD-accredited courses on the mandatory e-invoicing rails. Completing
          a course mints a certificate with a verifiable serial.
        </p>
      </div>

      {lastCertificate && (
        <Card
          className="border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40"
          data-testid="card-minted-certificate"
        >
          <CardContent className="pt-6 flex items-center gap-4">
            <Award className="w-10 h-10 text-emerald-700 dark:text-emerald-400 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm text-emerald-800 dark:text-emerald-300">
                Certificate minted — {lastCertificate.courseTitle}
              </p>
              <p
                className="text-xl md:text-2xl font-bold font-mono text-emerald-900 dark:text-emerald-200 break-all"
                data-testid="text-certificate-serial"
              >
                {lastCertificate.serial}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {courses.length === 0 ? (
        <p className="text-muted-foreground" data-testid="text-empty-courses">
          No courses published yet.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {courses.map((course) => (
            <CourseCard
              key={course.id}
              course={course}
              enrollment={enrollmentByCourse.get(course.id)}
              onEnroll={() => handleEnroll(course)}
              onComplete={() => handleComplete(course)}
              busy={
                (enroll.isPending || complete.isPending) &&
                pendingCourseId === course.id
              }
            />
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Firm enrollments</CardTitle>
        </CardHeader>
        <CardContent>
          {(enrollments ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-empty-enrollments">
              No enrollments yet. Enroll in a course above to get started.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 font-medium">Course</th>
                    <th className="py-2 font-medium">User</th>
                    <th className="py-2 font-medium">Status</th>
                    <th className="py-2 font-medium">Completed</th>
                    <th className="py-2 font-medium">Certificate</th>
                  </tr>
                </thead>
                <tbody>
                  {(enrollments ?? []).map((e) => (
                    <tr
                      key={e.id}
                      className="border-b last:border-0"
                      data-testid={`row-enrollment-${e.id}`}
                    >
                      <td className="py-2.5 font-medium">
                        {e.courseTitle}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({e.cpdHours} hr{e.cpdHours === 1 ? "" : "s"})
                        </span>
                      </td>
                      <td className="py-2.5 text-muted-foreground">
                        {e.userName ?? e.userId}
                      </td>
                      <td className="py-2.5">
                        <span className={enrollmentBadgeClasses(e.status)}>
                          {enrollmentLabel(e.status)}
                        </span>
                      </td>
                      <td className="py-2.5 text-muted-foreground">
                        {formatDate(e.completedAt)}
                      </td>
                      <td className="py-2.5 font-mono text-xs">
                        {e.certificateSerial ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
