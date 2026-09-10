// @vitest-environment jsdom
// The shadcn primitives the shell apps share (R126). Each renders once here
// so the accessible surface every app relies on — roles, names and the
// dismiss/close controls — is pinned where the code now lives, independent
// of any one app's page suites.
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Button, buttonVariants } from "./button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card";
import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { Label } from "./label";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "./popover";
import { Select, SelectTrigger, SelectValue } from "./select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";
import { Skeleton } from "./skeleton";
import { Spinner } from "./spinner";
import { Switch } from "./switch";
import { Textarea } from "./textarea";
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast";
import { Toaster } from "./toaster";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";
import { toast } from "../use-toast";
import { QueryError } from "../query-error";

// Radix's popper positioning needs a ResizeObserver; jsdom has none.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverStub;

afterEach(cleanup);

test("button renders a button and buttonVariants composes the class list", () => {
  render(
    <Button variant="outline" size="sm">
      Save
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Save" });
  expect(button.tagName).toBe("BUTTON");
  expect(buttonVariants({ variant: "destructive" })).toContain(
    "bg-destructive",
  );
});

test("button asChild renders the child element in place of a button", () => {
  render(
    <Button asChild>
      <a href="/next">Continue</a>
    </Button>,
  );
  expect(screen.getByRole("link", { name: "Continue" }).tagName).toBe("A");
});

test("card title is an h2 so card-led pages keep their heading order", () => {
  render(
    <Card>
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
        <CardDescription>This month</CardDescription>
      </CardHeader>
      <CardContent>Body</CardContent>
      <CardFooter>Footer</CardFooter>
    </Card>,
  );
  expect(
    screen.getByRole("heading", { level: 2, name: "Invoices" }),
  ).toBeTruthy();
  expect(screen.getByText("This month")).toBeTruthy();
});

test("checkbox and switch expose their roles and checked state", () => {
  render(
    <>
      <Checkbox aria-label="Agree" defaultChecked />
      <Switch aria-label="Notify" />
    </>,
  );
  const checkbox = screen.getByRole("checkbox", { name: "Agree" });
  expect(checkbox.getAttribute("aria-checked")).toBe("true");
  const toggle = screen.getByRole("switch", { name: "Notify" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

test("label, input and textarea wire up as labelled text boxes", () => {
  render(
    <>
      <Label htmlFor="tin">TIN</Label>
      <Input id="tin" defaultValue="123" />
      <Label htmlFor="note">Note</Label>
      <Textarea id="note" defaultValue="Hello" />
    </>,
  );
  const tin = screen.getByRole("textbox", { name: "TIN" });
  expect(tin.tagName).toBe("INPUT");
  const note = screen.getByRole("textbox", { name: "Note" });
  expect(note.tagName).toBe("TEXTAREA");
});

test("alert has the alert role with its title and description", () => {
  render(
    <Alert variant="destructive">
      <AlertTitle>Heads up</AlertTitle>
      <AlertDescription>Something needs attention.</AlertDescription>
    </Alert>,
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Heads up");
  expect(alert.textContent).toContain("Something needs attention.");
});

test("alert dialog opens as an alertdialog with its action and cancel buttons", () => {
  render(
    <AlertDialog open>
      <AlertDialogTrigger>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete invoice?</AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  );
  const dialog = screen.getByRole("alertdialog", { name: "Delete invoice?" });
  expect(dialog).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "Delete" }).length,
  ).toBeGreaterThan(0);
});

test("sheet opens as a dialog with a Close control", () => {
  render(
    <Sheet open>
      <SheetTrigger>Open filters</SheetTrigger>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>Narrow the list.</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <SheetClose>Done</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>,
  );
  expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
});

test("popover renders its content as a dialog when open", () => {
  render(
    <Popover open>
      <PopoverAnchor />
      <PopoverTrigger>More</PopoverTrigger>
      <PopoverContent>Details here</PopoverContent>
    </Popover>,
  );
  expect(screen.getByRole("dialog").textContent).toContain("Details here");
});

test("tooltip content renders inside the provider when open", () => {
  render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger>Status</TooltipTrigger>
        <TooltipContent>Stamped yesterday</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  expect(screen.getByRole("tooltip").textContent).toContain(
    "Stamped yesterday",
  );
});

test("select trigger is a combobox showing its placeholder while closed", () => {
  render(
    <Select>
      <SelectTrigger aria-label="Status">
        <SelectValue placeholder="Any status" />
      </SelectTrigger>
    </Select>,
  );
  const trigger = screen.getByRole("combobox", { name: "Status" });
  expect(trigger.textContent).toContain("Any status");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("skeleton and spinner announce loading without a visible label", () => {
  render(
    <>
      <Skeleton data-testid="skeleton" className="h-4" />
      <Spinner />
    </>,
  );
  expect(screen.getByTestId("skeleton").className).toContain("animate-pulse");
  expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
});

test("toast renders its title, action and the Dismiss notification control", () => {
  render(
    <ToastProvider>
      <Toast open variant="destructive">
        <ToastTitle>Failed</ToastTitle>
        <ToastDescription>Try again later.</ToastDescription>
        <ToastAction altText="Retry now">Retry</ToastAction>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>,
  );
  expect(screen.getByText("Failed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Dismiss notification" }),
  ).toBeTruthy();
});

test("toaster shows a toast raised through the shared store", () => {
  render(<Toaster />);
  act(() => {
    toast({ title: "Saved", description: "Invoice stored." });
  });
  expect(screen.getByText("Saved")).toBeTruthy();
  expect(screen.getByText("Invoice stored.")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Dismiss notification" }),
  ).toBeTruthy();
});

test("query error names the thing and Try again calls the retry", () => {
  const onRetry = vi.fn();
  render(<QueryError thing="invoices" onRetry={onRetry} />);
  expect(screen.getByTestId("text-error").textContent).toBe(
    "Unable to load invoices.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(onRetry).toHaveBeenCalledOnce();
});
