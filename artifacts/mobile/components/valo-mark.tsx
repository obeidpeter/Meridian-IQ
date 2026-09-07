import React from "react";
import Svg, { Path, type SvgProps } from "react-native-svg";

/** The adjacent Valo wordmark supplies the accessible name. */
export function ValoMark(props: SvgProps) {
  return (
    <Svg
      width={32}
      height={32}
      viewBox="0 0 32 32"
      fill="none"
      color="#ffffff"
      accessible={false}
      {...props}
    >
      <Path
        d="M6 7 16 25 26 7"
        stroke="currentColor"
        strokeWidth={4.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
