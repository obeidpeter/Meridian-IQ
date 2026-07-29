import { recordConsent } from "../modules/consent/consent";

// Shared DB seeders (refactoring survey item 28) — the fixture writes that
// several suites spell identically. Keep these THIN: a seeder is a named
// spelling of one canonical write, not a fixture framework.

// Layer-1 compliance consent — the grant every submitting supplier fixture
// needs (CORE-03 gates submission on it). One canonical spelling of the
// grant so a consent-shape change lands in one place.
export async function grantComplianceConsent(
  partyId: string,
  actorId: string,
): Promise<void> {
  await recordConsent({
    partyId,
    layer: 1,
    action: "grant",
    scope: "compliance",
    basis: "contract",
    channel: "test",
    actorId,
  });
}
