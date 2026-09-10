import {
  getGetErrorCatalogueEntryQueryKey,
  getGetInvoiceQueryKey,
  getGetInvoiceStatusLightQueryKey,
  getListSubmissionAttemptsQueryKey,
  useGetErrorCatalogueEntry,
  useGetInvoice,
  useGetInvoiceStatusLight,
  useListSubmissionAttempts,
  useSubmitInvoice,
  useValidateInvoice,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";

import { apiErrorMessage } from "@/lib/api-error";
import {
  latestFailedErrorCode,
  sortAttemptsNewestFirst,
} from "@/lib/invoice-detail";

/**
 * The invoice detail screen's reads and actions in one bag: the invoice,
 * its transmission attempts (newest first) and compliance light, the error
 * catalogue entry behind the newest failure, and the validate-then-submit
 * flow with its banner.
 */
export function useInvoiceDetail(id: string) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const detailQuery = useGetInvoice(id, {
    // A deleted or stale deep-linked invoice 404s — don't retry before we can
    // show the EmptyState.
    query: { enabled: !!id, queryKey: getGetInvoiceQueryKey(id), retry: false },
  });
  const attemptsQuery = useListSubmissionAttempts(id, {
    query: { enabled: !!id, queryKey: getListSubmissionAttemptsQueryKey(id) },
  });
  // Progressive enhancement — if the light can't load, its card simply
  // doesn't render. Never let it break the rest of the screen.
  const statusLightQuery = useGetInvoiceStatusLight(id, {
    query: {
      enabled: !!id,
      queryKey: getGetInvoiceStatusLightQueryKey(id),
      retry: false,
      staleTime: 30_000,
    },
  });

  const invoice = detailQuery.data?.invoice;
  const lines = detailQuery.data?.lines ?? [];
  const attempts = sortAttemptsNewestFirst(attemptsQuery.data ?? []);

  const errorCode = latestFailedErrorCode(attempts);
  const catalogueQuery = useGetErrorCatalogueEntry(errorCode ?? "", {
    query: {
      enabled: !!errorCode && invoice?.status === "failed",
      queryKey: getGetErrorCatalogueEntryQueryKey(errorCode ?? ""),
    },
  });
  const catalogue = catalogueQuery.data;

  const validate = useValidateInvoice();
  const submit = useSubmitInvoice();
  const [banner, setBanner] = useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);

  const refreshInvoice = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getGetInvoiceQueryKey(id) });
    void queryClient.invalidateQueries({
      queryKey: getListSubmissionAttemptsQueryKey(id),
    });
  }, [queryClient, id]);

  const onRefresh = useCallback(() => {
    void detailQuery.refetch();
    void attemptsQuery.refetch();
  }, [detailQuery, attemptsQuery]);

  const busy = validate.isPending || submit.isPending;

  const handleSubmit = useCallback(async () => {
    if (!invoice) return;
    setBanner(null);
    try {
      if (invoice.status === "draft") {
        const res = await validate.mutateAsync({ id });
        if (!res.ok) {
          refreshInvoice();
          setBanner({
            tone: "error",
            message:
              res.errors[0]?.message ||
              "This invoice needs changes before it can be submitted.",
          });
          return;
        }
      }
      await submit.mutateAsync({ id });
      refreshInvoice();
      setBanner({
        tone: "success",
        message:
          invoice.status === "failed"
            ? "Retry accepted — the invoice is back on the rail. We'll notify you once it clears."
            : "Submitted for stamping. We'll notify you once it clears the rail.",
      });
    } catch (e) {
      setBanner({
        tone: "error",
        message: apiErrorMessage(
          e,
          "We couldn't submit this invoice. Please try again.",
        ),
      });
    }
  }, [invoice, id, validate, submit, refreshInvoice]);

  const isFailed = invoice?.status === "failed";
  const canSubmit =
    invoice?.status === "draft" || invoice?.status === "validated";
  const retriableKnown = catalogue ? catalogue.retriable : true;

  const goToFix = useCallback(() => {
    router.push({
      pathname: "/invoices/edit/[id]",
      params: { id, ...(errorCode ? { code: errorCode } : {}) },
    });
  }, [router, id, errorCode]);

  return {
    detailQuery,
    attemptsQuery,
    statusLightQuery,
    invoice,
    lines,
    attempts,
    errorCode,
    catalogue,
    banner,
    onRefresh,
    busy,
    handleSubmit,
    isFailed,
    canSubmit,
    retriableKnown,
    goToFix,
  };
}
