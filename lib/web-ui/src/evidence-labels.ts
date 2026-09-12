import { useEvidenceRead } from "./evidence-state";
import type { EvidenceApi } from "./evidence-types";

export function useEvidenceClientLabels(api: EvidenceApi, ids: string[]) {
  const unique = [...new Set(ids)].sort();
  return useEvidenceRead(async (signal) => {
    if (!api.clientName) return {} as Record<string, string>;
    const results = await Promise.allSettled(
      unique.map((id) => api.clientName!(id, signal)),
    );
    return Object.fromEntries(
      results.flatMap((result) =>
        result.status === "fulfilled"
          ? [[result.value.id, result.value.label]]
          : [],
      ),
    );
  }, unique);
}

export function useEvidencePeople(api: EvidenceApi) {
  return useEvidenceRead(async (signal) => {
    const people = (await api.owners?.(signal)) ?? [];
    return Object.fromEntries(
      people.map((person) => [person.id, person.label]),
    );
  }, []);
}
