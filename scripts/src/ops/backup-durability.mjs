import { closeSync, fsyncSync, openSync } from "node:fs";
import path from "node:path";

export function syncBackupDirectory(directory) {
  // Also persist the destination's own directory entry when it was just created.
  for (const entry of new Set([directory, path.dirname(directory)])) {
    let fd;
    try {
      fd = openSync(entry, "r");
      fsyncSync(fd);
    } catch (cause) {
      throw new Error(
        "backup directory fsync failed; durable publication is refused on this filesystem/platform",
        { cause },
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
