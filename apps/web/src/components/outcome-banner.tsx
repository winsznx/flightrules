import type { ReactNode } from "react";
import type { Outcome } from "@/lib/outcome";

/**
 * What the last action did, rendered from the URL.
 *
 * Both states are words and structure, never a hue: `design.md` defines no success or failure
 * colour and this product has neither (ADR-0011). A failure additionally carries `role="alert"` and
 * the product's own PRD section 19 code, which is what an operator can quote.
 */
export function OutcomeBanner(props: { readonly outcome: Outcome | null }): ReactNode {
  const outcome = props.outcome;
  if (outcome === null) return null;

  if (outcome.kind === "done") {
    return (
      <p className="fr-toast" data-testid="action-succeeded" role="status">
        {outcome.action} — done.
      </p>
    );
  }

  return (
    <div className="fr-state fr-state--error" data-testid="action-failed" role="alert">
      <p className="fr-state__title">{outcome.action} did not complete. Nothing was changed.</p>
      {outcome.detail === null ? null : <p className="fr-state__body">{outcome.detail}</p>}
      {outcome.code === null ? null : (
        <p className="fr-mono fr-muted" style={{ marginTop: "var(--spacing-11)" }}>
          {outcome.code}
        </p>
      )}
    </div>
  );
}
