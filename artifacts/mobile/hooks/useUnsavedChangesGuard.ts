import { useNavigation, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Alert } from "react-native";

/**
 * Unsaved-changes guard for a pushed Stack screen: a header-back or an iOS
 * swipe-back would otherwise silently discard typed fixes. expo-router
 * doesn't re-export usePreventRemove, so we hook the underlying `beforeRemove`
 * navigation event it's built on. `allowLeaveRef` lets a confirmed discard or
 * a successful save proceed without re-prompting — the caller flips it before
 * navigating away after a save.
 */
export function useUnsavedChangesGuard(isDirty: boolean) {
  const navigation = useNavigation();
  const router = useRouter();
  const allowLeaveRef = useRef(false);

  // The shared "Discard changes?" confirm for both leave paths (header/gesture
  // back and the Cancel button). Confirming clears the guard so the discard
  // navigation isn't re-prompted.
  const confirmDiscard = (onDiscard: () => void) => {
    Alert.alert(
      "Discard changes?",
      "You have unsaved fixes on this invoice. If you leave now, they'll be lost.",
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            allowLeaveRef.current = true;
            onDiscard();
          },
        },
      ],
    );
  };

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (allowLeaveRef.current || !isDirty) return;
      e.preventDefault();
      confirmDiscard(() => navigation.dispatch(e.data.action));
    });
    return unsubscribe;
  }, [navigation, isDirty]);

  // Cancel button — confirm before discarding when there are unsaved changes.
  const confirmLeave = () => {
    if (!isDirty) {
      router.back();
      return;
    }
    confirmDiscard(() => router.back());
  };

  return { allowLeaveRef, confirmLeave };
}
