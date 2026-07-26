"use client";

import { type ReactNode, useState } from "react";

/**
 * `Copy evidence summary` (PRD section 8.12's secondary actions).
 *
 * The fourth and last client component in this application, and the narrowest justification of the
 * four: writing to the clipboard is something only a browser can do. It holds one boolean and copies
 * text it was handed; it fetches nothing, derives nothing and knows nothing about violations.
 *
 * The summary is also rendered beside it in a read-only `<textarea>`, so a user without clipboard
 * permission — or without JavaScript — can still select and copy it. The button is an accelerator,
 * never the only route to the text.
 */
export function CopyButton(props: {
  readonly text: string;
  readonly label: string;
  readonly testId?: string;
}): ReactNode {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  return (
    <button
      className="fr-button fr-button--ghost"
      data-testid={props.testId}
      onClick={() => {
        navigator.clipboard.writeText(props.text).then(
          () => {
            setState("copied");
          },
          () => {
            // A denied clipboard permission is not an error worth an alert: the text is on the page.
            setState("failed");
          },
        );
      }}
      type="button"
    >
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Select the summary below to copy"
          : props.label}
    </button>
  );
}
