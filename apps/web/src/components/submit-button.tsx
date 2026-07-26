"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * A form's submit control, disabled while its own action is in flight.
 *
 * PRD Phase 13 requires pending, success and error states and forbids duplicate submission. The
 * success and error states are server-rendered from the URL; this covers the window between the
 * click and the response, during which a second click would submit the same action again.
 *
 * `useFormStatus` reports the status of the form this button is inside, so several forms on one
 * page — the Contract Studio has six — do not disable each other.
 *
 * The server is still the authority. Every action this button submits is idempotent on the server:
 * job submission is keyed, and a lifecycle transition from a state that has already moved is
 * refused by `canTransition`. This only removes the pointless second request.
 */
export function SubmitButton(props: {
  readonly children: ReactNode;
  readonly pendingLabel?: string;
  readonly ghost?: boolean;
  readonly testId?: string;
  readonly formAction?: (formData: FormData) => void | Promise<void>;
}): ReactNode {
  const status = useFormStatus();
  const className = props.ghost === true ? "fr-button fr-button--ghost" : "fr-button";

  return (
    <button
      className={className}
      type="submit"
      disabled={status.pending}
      aria-busy={status.pending ? "true" : undefined}
      data-testid={props.testId}
      {...(props.formAction === undefined ? {} : { formAction: props.formAction })}
    >
      {status.pending ? (props.pendingLabel ?? "Working…") : props.children}
    </button>
  );
}
