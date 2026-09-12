import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Save, Trash2 } from "lucide-react";
import { ProtectedNavigation } from "./protected-navigation";
import type { UnsavedWorkHandler } from "./unsaved-work-controller";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

const NavigationContext = createContext<ProtectedNavigation | null>(null);

const queryChangeEvent = "valo:querychange";
function subscribeQuery(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(queryChangeEvent, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(queryChangeEvent, listener);
  };
}

// Existing URL-backed tabs/filters share the accepted router snapshot. Their
// query must not jump to a blocked Back target while history is being restored.
export function useNavigationQuery(): [
  string,
  (param: string, value: string | null) => void,
] {
  const navigation = useContext(NavigationContext);
  const read = useCallback(
    () =>
      navigation ? navigation.getSnapshot().search : window.location.search,
    [navigation],
  );
  const search = useSyncExternalStore(
    navigation?.subscribe ?? subscribeQuery,
    read,
  );
  const replace = useCallback(
    (param: string, value: string | null) => {
      const snapshot = navigation?.getSnapshot();
      const url = new URL(
        snapshot
          ? snapshot.pathname + snapshot.search + snapshot.hash
          : window.location.href,
        window.location.origin,
      );
      if (value === null) url.searchParams.delete(param);
      else url.searchParams.set(param, value);
      if (navigation) {
        navigation.navigate(url, { replace: true, state: snapshot?.state });
      } else {
        window.history.replaceState(window.history.state, "", url);
        window.dispatchEvent(new Event(queryChangeEvent));
      }
    },
    [navigation],
  );
  return [search, replace];
}

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

/** Register while mounted, not only while dirty: successful saves must be able
 * to clear dirty state without invalidating their pending navigation request. */
export function useUnsavedWork({
  dirty,
  save,
  discard,
  disabledReason,
}: {
  dirty: boolean;
  save: () => Promise<boolean>;
  discard: () => boolean;
  disabledReason?: string | null;
}) {
  const navigation = useContext(NavigationContext);
  const current = useRef({ dirty, save, discard, disabledReason });
  useLayoutEffect(() => {
    current.current = { dirty, save, discard, disabledReason };
  });
  useLayoutEffect(() => {
    const handler: UnsavedWorkHandler = {
      isDirty: () => current.current.dirty,
      save: async () => {
        const saved = await current.current.save();
        if (saved) current.current.dirty = false;
        return saved;
      },
      discard: () => {
        const discarded = current.current.discard();
        if (discarded) current.current.dirty = false;
        return discarded;
      },
      saveDisabledReason: () => current.current.disabledReason,
    };
    if (navigation) return navigation.work.register(handler);
    // Standalone form consumers retain the existing tab-close safeguard.
    const warn = (event: BeforeUnloadEvent) => {
      if (!handler.isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [navigation, disabledReason]);
}

function UnsavedWorkDialog({
  navigation,
}: {
  navigation: ProtectedNavigation;
}) {
  const work = navigation.work;
  const prompt = useSyncExternalStore(work.subscribe, work.getSnapshot);
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <AlertDialog
      open={Boolean(prompt)}
      onOpenChange={(open) => {
        if (!open) work.stay();
      }}
    >
      <AlertDialogContent
        className="w-[calc(100%-2rem)]"
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const invalid = document.querySelector<HTMLElement>(
            '[aria-invalid="true"]',
          );
          if (invalid) invalid.focus();
          else if (returnFocus.current?.isConnected)
            returnFocus.current.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Save your changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes. Save them before leaving, discard them, or
            stay on this page.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {prompt?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {prompt.error}
          </p>
        ) : null}
        <p role="status" className="text-sm text-muted-foreground">
          {prompt?.busy ? "Saving changes..." : ""}
        </p>
        <AlertDialogFooter className="gap-2 sm:space-x-0">
          <AlertDialogCancel onClick={work.stay}>Stay</AlertDialogCancel>
          <Button
            variant="outline"
            disabled={prompt?.busy}
            onClick={work.discard}
          >
            <Trash2 aria-hidden="true" />
            Discard
          </Button>
          <Button
            aria-disabled={prompt?.busy || undefined}
            aria-busy={prompt?.busy || undefined}
            onClick={() => void work.save()}
          >
            <Save aria-hidden="true" />
            Save
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
