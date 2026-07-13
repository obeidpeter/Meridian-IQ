import React from "react";
import {
  KeyboardAwareScrollView,
  KeyboardAwareScrollViewProps,
} from "react-native-keyboard-controller";
import { Platform, ScrollView, ScrollViewProps } from "react-native";

type Props = KeyboardAwareScrollViewProps & ScrollViewProps;

export function KeyboardAwareScrollViewCompat({
  children,
  keyboardShouldPersistTaps = "handled",
  ...props
}: Props) {
  if (Platform.OS === "web") {
    return (
      <ScrollView keyboardShouldPersistTaps={keyboardShouldPersistTaps} {...props}>
        {children}
      </ScrollView>
    );
  }
  return (
    <KeyboardAwareScrollView
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      {...props}
    >
      {children}
    </KeyboardAwareScrollView>
  );
}

// Minimal handle we need from the scroll view — just the imperative scrollTo.
export type Scrollable = {
  scrollTo?: (opts?: { x?: number; y?: number; animated?: boolean }) => void;
};

// React 19 forwards `ref` to function components as a prop, and the compat
// wrapper spreads its props onto the underlying ScrollView — so a ref set here
// reaches the real scroll view. The cast just teaches TS that this host accepts
// the ref (the wrapper's own prop types don't declare it).
export const ScrollHost = KeyboardAwareScrollViewCompat as unknown as React.ComponentType<
  React.ComponentProps<typeof KeyboardAwareScrollViewCompat> & {
    ref?: React.Ref<Scrollable>;
  }
>;
