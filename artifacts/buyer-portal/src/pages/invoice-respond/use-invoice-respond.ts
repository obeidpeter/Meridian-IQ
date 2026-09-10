import { useRef, useState } from "react";
import { useParams } from "wouter";
import {
  useGetBuyerInvoice,
  useCreateConfirmation,
  useFlagPayment,
  useGetMe,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { errorDescription, type ResponseState } from "@/lib/respond";
import { usePageTitle } from "@/hooks/use-page-title";

// The whole page's state in one bag (R126): the invoice query, the buyer
// identity, the response form's fields, the two mutations and the
// fresh-request check the outcome cards share.
export function useInvoiceRespond() {
  const params = useParams();
  const id = params.id as string;
  const {
    data: invoice,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useGetBuyerInvoice(id);
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [response, setResponse] = useState<ResponseState | null>(null);
  const [method, setMethod] = useState("portal");
  const [note, setNote] = useState("");
  // The note-validation message on screen (null = no complaint yet). Only
  // set on a submit attempt, cleared as soon as the input satisfies it.
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noSetOff, setNoSetOff] = useState(false);
  // Post-action confirmation: which response THIS visit just recorded. The
  // refetched confirmationState alone can't distinguish "you responded just
  // now" from "you responded last week", so keep the moment explicit.
  const [submitted, setSubmitted] = useState<ResponseState | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const confirm = useCreateConfirmation();
  const flag = useFlagPayment();

  usePageTitle(invoice ? invoice.invoiceNumber : "Invoice");

  const checkForNewRequest = async () => {
    try {
      const result = await refetch({ throwOnError: true });
      if (result.data?.confirmationState === "requested") {
        setResponse(null);
        setNote("");
        setNoteError(null);
        setNoSetOff(false);
        setMethod("portal");
        setSubmitted(null);
        toast({ title: "A new request is ready for your response" });
      } else {
        toast({
          title: "No new request yet",
          description:
            "Your earlier response is still recorded. Check again after the supplier sends a new request.",
        });
      }
    } catch (err) {
      toast({
        title: "Could not check for a new request",
        description: errorDescription(err),
        variant: "destructive",
      });
    }
  };

  return {
    invoice,
    isLoading,
    isFetching,
    error,
    refetch,
    me,
    queryClient,
    toast,
    response,
    setResponse,
    method,
    setMethod,
    note,
    setNote,
    noteError,
    setNoteError,
    noSetOff,
    setNoSetOff,
    submitted,
    setSubmitted,
    noteRef,
    confirm,
    flag,
    checkForNewRequest,
  };
}

export type InvoiceRespondState = ReturnType<typeof useInvoiceRespond>;
