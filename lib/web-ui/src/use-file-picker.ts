import { useRef } from "react";
import type { ChangeEvent, RefObject } from "react";

/**
 * Headless plumbing for a hidden file input behind a styled trigger button,
 * shared by the apps' upload flows. Owns the ref and — the invariant that
 * kept getting lost in hand-rolled copies — the value reset that lets the
 * user re-select the same (fixed) file and have onFile fire again.
 *
 * Render the hidden input yourself and spread inputProps on it; wire any
 * button to openPicker:
 *
 *   const { inputProps, openPicker } = useFilePicker(onFile);
 *   <input type="file" accept=".csv" className="hidden" {...inputProps} />
 *   <Button onClick={openPicker}>Upload CSV</Button>
 */
export function useFilePicker(onFile: (file: File) => void): {
  inputProps: {
    ref: RefObject<HTMLInputElement | null>;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  };
  openPicker: () => void;
} {
  const fileRef = useRef<HTMLInputElement>(null);
  return {
    inputProps: {
      ref: fileRef,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) onFile(file);
        // Allow re-selecting the same (fixed) file.
        e.target.value = "";
      },
    },
    openPicker: () => fileRef.current?.click(),
  };
}
