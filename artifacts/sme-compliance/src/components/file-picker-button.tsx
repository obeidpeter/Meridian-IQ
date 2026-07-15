import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";

/**
 * Hidden file input plus its outline trigger button, shared by the bulk-import
 * and reconciliation upload flows. Owns the ref and the value reset that lets
 * the user re-select the same (fixed) file; each page keeps its own onFile
 * handler and read-failure toast.
 */
export function FilePickerButton({
  accept,
  label,
  onFile,
}: {
  accept: string;
  label: string;
  onFile: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          // Allow re-selecting the same (fixed) file.
          e.target.value = "";
        }}
      />
      <Button variant="outline" onClick={() => fileRef.current?.click()}>
        <Upload className="w-4 h-4 mr-2" aria-hidden="true" /> {label}
      </Button>
    </>
  );
}
