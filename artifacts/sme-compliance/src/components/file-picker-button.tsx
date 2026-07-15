import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";
import { useFilePicker } from "@workspace/web-ui";

/**
 * Hidden file input plus its outline trigger button, shared by the bulk-import
 * and reconciliation upload flows. The input plumbing (ref, same-file
 * re-select reset) lives in @workspace/web-ui; each page keeps its own onFile
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
  const { inputProps, openPicker } = useFilePicker(onFile);
  return (
    <>
      <input type="file" accept={accept} className="hidden" {...inputProps} />
      <Button variant="outline" onClick={openPicker}>
        <Upload className="w-4 h-4 mr-2" aria-hidden="true" /> {label}
      </Button>
    </>
  );
}
