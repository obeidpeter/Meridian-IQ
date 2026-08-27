import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent, RefObject } from "react";

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
 *
 * A drop target is optional: spread dropProps on any container to accept a
 * dragged-in file through the same onFile, and use dragActive to highlight
 * the target while a file drag hovers it. Text drags (e.g. into a child
 * textarea) keep their native behaviour — only file drops are intercepted.
 */
export function useFilePicker(onFile: (file: File) => void): {
  inputProps: {
    ref: RefObject<HTMLInputElement | null>;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  };
  openPicker: () => void;
  dragActive: boolean;
  dropProps: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragEnter: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
} {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  // dragenter/dragleave fire for every child element crossed; depth-count so
  // moving over children doesn't flicker the highlight off.
  const dragDepth = useRef(0);
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
    dragActive,
    dropProps: {
      // preventDefault marks the container as a valid drop target.
      onDragOver: (e) => e.preventDefault(),
      onDragEnter: (e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      },
      onDragLeave: () => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      },
      onDrop: (e) => {
        dragDepth.current = 0;
        setDragActive(false);
        const file = e.dataTransfer?.files?.[0];
        // No file: let a text drop keep the browser's native behaviour.
        if (!file) return;
        e.preventDefault();
        onFile(file);
      },
    },
  };
}
