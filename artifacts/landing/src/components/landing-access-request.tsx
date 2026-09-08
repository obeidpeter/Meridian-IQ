import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import {
  requestPlatformAccess,
  type PlatformAccessRequestInput,
} from "@workspace/api-client-react";
import { trackUsabilityEvent } from "@workspace/web-ui";
import { serverErrorFrom } from "@/lib/errors";

const INITIAL: PlatformAccessRequestInput = {
  name: "",
  email: "",
  businessName: "",
  interest: "business",
  teamSize: "two_to_ten",
  message: "",
  consent: false,
  website: "",
};

export function LandingAccessRequest({ contact }: { contact: string }) {
  const [form, setForm] = useState<PlatformAccessRequestInput>(INITIAL);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const pending = useRef(false);
  const restoreInputFocus = useRef(false);
  const result = useRef<HTMLDivElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (status === "sent" || status === "error") result.current?.focus();
    if (status === "idle" && restoreInputFocus.current) {
      firstInput.current?.focus();
      restoreInputFocus.current = false;
    }
  }, [status]);
  const update = <Key extends keyof PlatformAccessRequestInput>(
    key: Key,
    value: PlatformAccessRequestInput[Key],
  ) => {
    if (!started.current) {
      started.current = true;
      trackUsabilityEvent("access_request_started", "access_request");
    }
    setForm((current) => ({ ...current, [key]: value }));
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setStatus("sending");
    setError(null);
    try {
      await requestPlatformAccess({
        ...form,
        name: form.name.trim(),
        email: form.email.trim(),
        businessName: form.businessName.trim(),
        message: form.message?.trim() || undefined,
      });
      setStatus("sent");
    } catch (requestError) {
      setStatus("error");
      setError(
        serverErrorFrom(requestError) ??
          "We could not send your request. Try again or use the email option.",
      );
    } finally {
      pending.current = false;
    }
  };
  if (status === "sent")
    return (
      <div
        className="editorial-contact-result"
        tabIndex={-1}
        ref={result}
        role="status"
      >
        <Check size={28} aria-hidden="true" />
        <h3>Your request is with us.</h3>
        <p>
          Thanks, {form.name}. We will review what you need and reply to{" "}
          <strong>{form.email}</strong>.
        </p>
        <button
          type="button"
          className="editorial-text-link"
          onClick={() => {
            restoreInputFocus.current = true;
            setForm(INITIAL);
            setStatus("idle");
            started.current = false;
          }}
        >
          Send another request <ArrowUpRight size={18} aria-hidden="true" />
        </button>
      </div>
    );
  return (
    <form
      onSubmit={submit}
      className="editorial-enquiry"
      aria-label="Talk to us"
      aria-busy={status === "sending"}
      aria-describedby={error ? "access-request-error" : "access-required"}
    >
      <p id="access-required" className="editorial-small">
        All fields required unless marked optional.
      </p>
      <fieldset disabled={status === "sending"}>
        <legend className="sr-only">Your enquiry</legend>
        <div className="editorial-form-grid">
          <div>
            <label htmlFor="access-name">Your name</label>
            <input
              ref={firstInput}
              id="access-name"
              autoComplete="name"
              required
              minLength={2}
              maxLength={100}
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="access-email">Work email</label>
            <input
              id="access-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={form.email}
              onChange={(event) => update("email", event.target.value)}
            />
          </div>
          <div className="editorial-field-wide">
            <label htmlFor="access-business">Business or firm name</label>
            <input
              id="access-business"
              autoComplete="organization"
              required
              minLength={2}
              maxLength={140}
              value={form.businessName}
              onChange={(event) => update("businessName", event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="access-interest">I am interested as</label>
            <select
              id="access-interest"
              value={form.interest}
              onChange={(event) =>
                update(
                  "interest",
                  event.target.value as PlatformAccessRequestInput["interest"],
                )
              }
            >
              <option value="business">A business</option>
              <option value="accounting_firm">An accounting firm</option>
              <option value="buyer">A buyer or enterprise team</option>
              <option value="partnership">A partner</option>
            </select>
          </div>
          <div>
            <label htmlFor="access-team-size">Team size</label>
            <select
              id="access-team-size"
              value={form.teamSize}
              onChange={(event) =>
                update(
                  "teamSize",
                  event.target.value as PlatformAccessRequestInput["teamSize"],
                )
              }
            >
              <option value="one">Just me</option>
              <option value="two_to_ten">2–10 people</option>
              <option value="eleven_to_fifty">11–50 people</option>
              <option value="over_fifty">More than 50</option>
            </select>
          </div>
          <div className="editorial-field-wide">
            <label htmlFor="access-message">
              What would you like to solve? <span>(optional)</span>
            </label>
            <textarea
              id="access-message"
              rows={3}
              maxLength={1200}
              value={form.message}
              onChange={(event) => update("message", event.target.value)}
            />
          </div>
          <div className="editorial-honeypot" aria-hidden="true">
            <label htmlFor="access-website">Website (leave blank)</label>
            <input
              id="access-website"
              tabIndex={-1}
              autoComplete="off"
              value={form.website}
              onChange={(event) => update("website", event.target.value)}
            />
          </div>
          <label className="editorial-consent editorial-field-wide">
            <input
              type="checkbox"
              required
              checked={form.consent}
              onChange={(event) => update("consent", event.target.checked)}
            />
            <span>
              Valo may use these details to contact me about this request.
            </span>
          </label>
        </div>
      </fieldset>
      {error && (
        <div
          className="editorial-form-error"
          id="access-request-error"
          role="alert"
          tabIndex={-1}
          ref={result}
        >
          <strong>Your request was not sent.</strong>
          <p>{error}</p>
          <a className="editorial-text-link" href={contact}>
            Send it by email instead{" "}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </div>
      )}
      <button
        className="editorial-button"
        type="submit"
        disabled={status === "sending" || !form.consent}
      >
        {status === "sending" ? "Sending request…" : "Talk to us"}
        <ArrowUpRight size={18} aria-hidden="true" />
      </button>
    </form>
  );
}
