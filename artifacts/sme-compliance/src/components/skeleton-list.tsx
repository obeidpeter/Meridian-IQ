import { Skeleton } from "@/components/ui/skeleton";

/**
 * The standard list-loading placeholder: a stack of equal-height skeletons.
 * Pass the page's row height via itemClassName and (when it differs from the
 * usual space-y-3) the stack spacing via className.
 */
export function SkeletonList({
  count,
  itemClassName,
  className = "space-y-3",
}: {
  count: number;
  itemClassName: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={itemClassName} />
      ))}
    </div>
  );
}
