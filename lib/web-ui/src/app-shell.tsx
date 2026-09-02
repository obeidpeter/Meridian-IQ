import { Building2 } from "lucide-react";

/**
 * App-shell fragments shared by the workspace apps (R69). The sidebar and
 * top bar are app code (their nav tables differ), but the two chips every
 * header carries render identically, so they live here beside the
 * `.mi-topbar` styles they depend on.
 */

export type ReleaseTag = "R0" | "R1" | "R2" | "R3" | "R4";

// Roadmap names the release manifest (api-server modules/flags/releases.ts)
// groups its flags under. The tag itself comes from Me.releaseTag, which
// the server derives from the lit platform flags — the badge never guesses.
const RELEASE_NAMES: Record<ReleaseTag, string> = {
  R0: "Field Kit core",
  R1: "Compliance MVP",
  R2: "Channel Scale and Buyer Rails",
  R3: "Clerk programme and credit perimeter",
  R4: "Bank data room",
};

export function releaseBadgeLabel(tag: ReleaseTag): string {
  return `Release ${tag.slice(1)}`;
}

export function releaseBadgeTitle(tag: ReleaseTag): string {
  return `Activation stage ${tag}: ${RELEASE_NAMES[tag]}. Read from the platform feature flags; every flag at this release and below is on.`;
}

/**
 * The flag-driven release marker. Renders nothing until the session carries a
 * recognised tag, so an older server (no Me.releaseTag) simply shows no badge.
 */
export function ReleaseBadge({ tag }: { tag: string | null | undefined }) {
  if (!tag || !(tag in RELEASE_NAMES)) return null;
  const known = tag as ReleaseTag;
  return (
    <span
      className="mi-release-badge"
      data-testid="text-release-badge"
      title={releaseBadgeTitle(known)}
    >
      {releaseBadgeLabel(known)}
    </span>
  );
}

/**
 * Names the workspace the session is scoped to (the client business, the
 * firm, or a role-level fallback). Static by design: one session is one
 * workspace, so this is a label, not a switcher (architecture.md D13).
 */
export function WorkspaceChip({ name }: { name: string }) {
  return (
    <span
      className="mi-workspace-chip"
      data-testid="text-workspace-chip"
      title={name}
    >
      <Building2 aria-hidden="true" />
      <span>{name}</span>
    </span>
  );
}
