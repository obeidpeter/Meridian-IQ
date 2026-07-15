// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useFilePicker } from "./use-file-picker";

// RTL's auto-cleanup needs framework globals, which stay off here.
afterEach(cleanup);

function Harness({ onFile }: { onFile: (file: File) => void }) {
  const { inputProps, openPicker } = useFilePicker(onFile);
  return (
    <>
      <input type="file" data-testid="input" {...inputProps} />
      <button onClick={openPicker}>pick</button>
    </>
  );
}

describe("useFilePicker", () => {
  test("fires onFile with the chosen file and resets the input value", () => {
    const onFile = vi.fn();
    render(<Harness onFile={onFile} />);
    const input = screen.getByTestId<HTMLInputElement>("input");

    const file = new File(["a,b,c"], "statement.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(file);
    // The reset is the point: re-selecting the same (fixed) file must fire
    // the change event again instead of being a silent no-op.
    expect(input.value).toBe("");
  });

  test("ignores a change event with no file selected", () => {
    const onFile = vi.fn();
    render(<Harness onFile={onFile} />);
    fireEvent.change(screen.getByTestId("input"), { target: { files: [] } });
    expect(onFile).not.toHaveBeenCalled();
  });

  test("openPicker forwards to the hidden input's click", () => {
    const onFile = vi.fn();
    render(<Harness onFile={onFile} />);
    const input = screen.getByTestId<HTMLInputElement>("input");
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByText("pick"));
    expect(click).toHaveBeenCalledTimes(1);
  });
});
