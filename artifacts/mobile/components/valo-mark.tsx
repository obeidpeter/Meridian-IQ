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
        d="M2.8 5H9.6L15 15.8L11.6 22.6Z M22.4 3H29.2L16.8 27.8C16.4 28.6 15.2 28.6 14.8 27.8L12.8 23.8Z"
        fill="currentColor"
      />
    </Svg>
  );
}
