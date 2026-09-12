import {
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type ComponentType,
} from "react";
import { ProtectedNavigation } from "./protected-navigation";
import { NavigationContext } from "./navigation-context";
export { useNavigationQuery } from "./use-navigation-query";
export { useUnsavedWork } from "./use-unsaved-work";
export function UnsavedWorkProvider({ children }: { children: ReactNode }) {
  const [navigation] = useState(() => new ProtectedNavigation(window));
  useLayoutEffect(() => navigation.start(), [navigation]);
  return (
    <NavigationContext.Provider value={navigation}>
      {children}
      <UnsavedWorkDialog navigation={navigation} />
    </NavigationContext.Provider>
  );
}

function useNavigation() {
  const navigation = useContext(NavigationContext);
  if (!navigation)
    throw new Error("Protected router hooks require UnsavedWorkProvider.");
  return navigation;
}

export function useProtectedLocation(): [
  string,
  ProtectedNavigation["navigate"],
] {
  const navigation = useNavigation();
  const snapshot = useSyncExternalStore(
    navigation.subscribe,
    navigation.getSnapshot,
  );
  return [snapshot.pathname, navigation.navigate];
}

export function useProtectedSearch() {
  const navigation = useNavigation();
  return useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
    .search;
}

export function useProtectedHistoryState() {
  const navigation = useNavigation();
  return useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
    .state;
}

function UnsavedWorkDialog({
  navigation,
}: {
  navigation: ProtectedNavigation;
}) {
  const work = navigation.work;
  const prompt = useSyncExternalStore(work.subscribe, work.getSnapshot);
  const pending = Boolean(prompt);
  const [Dialog, setDialog] = useState<ComponentType<{
    navigation: ProtectedNavigation;
  }> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!pending || Dialog) return;
    let active = true;
    setFailed(false);
    void import("./unsaved-work-dialog").then(
      (module) => {
        if (active) setDialog(() => module.UnsavedWorkDialog);
      },
      () => {
        if (!active) return;
        setFailed(true);
        work.stay();
      },
    );
    return () => {
      active = false;
    };
  }, [pending, Dialog, work]);
  // Keep the loaded dialog mounted so Radix can restore focus when it closes.
  if (Dialog) return <Dialog navigation={navigation} />;
  return failed ? (
    <p role="alert">
      Unable to open the save prompt. Your changes are still here. Try
      navigating again.
    </p>
  ) : pending ? (
    <p role="status">Opening save prompt...</p>
  ) : null;
}
