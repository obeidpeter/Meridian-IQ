import type { SVGProps } from "react";

/** Two folded ribbons form the V; negative space stays open at small sizes. */
export function ValoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M2.8 5H9.6L15 15.8L11.6 22.6Z M22.4 3H29.2L16.8 27.8C16.4 28.6 15.2 28.6 14.8 27.8L12.8 23.8Z"
        fill="currentColor"
      />
    </svg>
  );
}
