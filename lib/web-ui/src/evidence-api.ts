import type { EvidenceApi, EvidenceDetailView } from "./evidence-types";

export function createEvidenceApi(
  operations: EvidenceApi,
  onMutation: (detail: EvidenceDetailView) => void,
): EvidenceApi {
  async function saved(result: Promise<EvidenceDetailView>) {
    const detail = await result;
    onMutation(detail);
    return detail;
  }
  return {
    ...operations,
    create: (input) => saved(operations.create(input)),
    update: (id, input) => saved(operations.update(id, input)),
    upload: (id, input) => saved(operations.upload(id, input)),
    review: (id, input) => saved(operations.review(id, input)),
    scan: (id, input) => saved(operations.scan(id, input)),
  };
}
