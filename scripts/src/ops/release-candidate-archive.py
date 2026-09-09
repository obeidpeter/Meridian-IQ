"""Strict release ZIP transport reader. No extractall and no package execution."""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import zipfile

APPS = {"api-server", "landing", "console", "sme-compliance", "buyer-portal",
        "penalty-calculator", "mobile"}
MANIFEST = "release/build-manifest.json"
MAX_BYTES = 4 * 1024**3
MAX_FILE = 512 * 1024**2
MAX_ENTRIES = 100000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_name(name):
    require(isinstance(name, str) and 0 < len(name) <= 1024, "invalid path length")
    parts = name.split("/")
    for part in parts:
        require(re.fullmatch(r"[A-Za-z0-9_@+.,()\[\] -]+", part) is not None,
                "unsafe archive path")
        require(part not in {".", ".."} and not part.endswith((".", " "))
                and not part.startswith(" "), "ambiguous path component")
        require(not re.fullmatch(r"(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?", part),
                "reserved path component")
    return name


def real_path(target):
    target = Path(os.path.abspath(target))
    for item in [*reversed(target.parents), target]:
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode)
                and not (getattr(info, "st_file_attributes", 0) & 0x400),
                "symlink/reparse point refused")
    return target


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def inspect(archive):
    infos = archive.infolist()
    require(0 < len(infos) <= MAX_ENTRIES, "ZIP entry limit")
    files, directories, folded = {}, set(), {}
    total = 0
    for info in infos:
        require(info.orig_filename == info.filename, "NUL in ZIP filename")
        name = safe_name(info.filename[:-1] if info.is_dir() else info.filename)
        require(name.casefold() not in folded, "duplicate/case-colliding ZIP entry")
        folded[name.casefold()] = name
        mode = info.external_attr >> 16
        kind = stat.S_IFMT(mode)
        require(kind in ({0, stat.S_IFDIR} if info.is_dir() else {0, stat.S_IFREG}),
                "non-regular ZIP entry (including symlinks) refused")
        require(not info.flag_bits & 1, "encrypted ZIP refused")
        require(info.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED},
                "unsupported ZIP compression")
        require(info.file_size <= MAX_FILE, "ZIP file size limit")
        total += info.file_size
        require(total <= MAX_BYTES, "ZIP expanded size limit")
        if info.is_dir():
            require(info.file_size == 0, "directory with content")
            directories.add(name)
        else:
            files[name] = info
    parents = set()
    for name in files:
        parts = name.split("/")
        parents.update("/".join(parts[:i]) for i in range(1, len(parts)))
    require(not (set(files) & parents), "file/directory collision")
    require(directories <= parents, "unexpected/empty ZIP directory")
    # Also reject aliases in implicit parent directories on case-insensitive hosts.
    aliases = {}
    for name in set(files) | parents:
        require(aliases.get(name.casefold(), name) == name, "case-colliding parent")
        aliases[name.casefold()] = name
    require(MANIFEST in files and MANIFEST + ".sha256" in files, "missing manifest pair")
    require(files[MANIFEST].file_size <= 32 * 1024**2, "manifest size limit")
    require(files[MANIFEST + ".sha256"].file_size <= 128, "checksum size limit")
    manifest_bytes = archive.read(files[MANIFEST])
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
    require(archive.read(files[MANIFEST + ".sha256"]) ==
            (manifest_hash + "  build-manifest.json\n").encode(), "manifest checksum mismatch")
    manifest = json.loads(manifest_bytes, object_pairs_hook=unique_object)
    require(manifest.get("format") == 1, "unsupported manifest format")
    assets = manifest.get("assets")
    require(isinstance(assets, list) and 0 < len(assets) <= MAX_ENTRIES, "invalid inventory")
    expected, apps = {}, set()
    for asset in assets:
        name = safe_name(asset["file"])
        parts = name.split("/")
        require(len(parts) >= 4 and parts[0] == "artifacts" and parts[1] in APPS
                and parts[2] == "dist", "inventory outside seven-app package")
        require(name not in expected, "duplicate manifest asset")
        require(re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]) is not None, "invalid asset hash")
        expected[name] = asset["sha256"]
        apps.add(parts[1])
    require(apps == APPS, "missing application")
    missing = set(expected) - set(files)
    require(not missing, "missing packaged asset")
    extras = set(files) - set(expected) - {MANIFEST, MANIFEST + ".sha256"}
    # build-manifest intentionally omits source maps. Retain only maps belonging
    # to an inventoried asset and hash them in transport evidence, never discard.
    require(all(name.endswith(".map") and name[:-4] in expected for name in extras),
            "extra unmanifested package file")
    inventory = []
    for name, info in sorted(files.items()):
        hasher = hashlib.sha256()
        size = 0
        with archive.open(info) as source:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                require(size <= info.file_size and size <= MAX_FILE, "expanded file size mismatch")
                hasher.update(chunk)
        require(size == info.file_size, "truncated ZIP member")
        digest = hasher.hexdigest()
        if name in expected:
            require(digest == expected[name], "asset checksum mismatch")
        inventory.append({"file": name, "sha256": digest, "bytes": size})
    return {"manifest": manifest, "manifestSha256": manifest_hash,
            "files": inventory, "transportOnlySourceMaps": sorted(extras)}, files


def main():
    require(len(sys.argv) in {2, 3}, "use archive.py <zip> [fresh-extraction-directory]")
    archive_path = real_path(sys.argv[1])
    require(archive_path.is_file() and archive_path.stat().st_size <= MAX_BYTES, "invalid archive")
    with zipfile.ZipFile(archive_path) as archive:
        report, files = inspect(archive)
        if len(sys.argv) == 3:
            target = Path(os.path.abspath(sys.argv[2]))
            real_path(target.parent)
            target.mkdir(mode=0o700)  # Exclusive: no merge or overwrite, even on failure.
            for name, info in files.items():
                destination = target.joinpath(*name.split("/"))
                destination.parent.mkdir(parents=True, exist_ok=True)
                real_path(destination.parent)
                with archive.open(info) as source, destination.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
        print(json.dumps(report))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No archive bytes, signed URLs, or untrusted filenames in error output.
        print("release ZIP refused: " + type(error).__name__ + ": " + str(error)
              if isinstance(error, ValueError) else "release ZIP refused: invalid archive or filesystem", file=sys.stderr)
        sys.exit(1)
