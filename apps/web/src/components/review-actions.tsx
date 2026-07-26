import type { ReactNode } from "react";
import { ROUTE_FAMILY } from "@/lib/copy";
import { decideRouteFamily } from "@/lib/review-actions";
import { SubmitButton } from "./submit-button";

/**
 * PRD section 8.8's four review actions, as four forms.
 *
 * Four separate forms rather than one form with four buttons, so each button's own pending state is
 * its own — `useFormStatus` reports the form it is inside — and so a keyboard user pressing Enter
 * in any of them submits the action they are on.
 *
 * The verbs are `ROUTE_FAMILY.actions`, which `web.test.ts` asserts against the PRD verbatim.
 */

const DECISIONS = ["approve", "reject", "markOptional", "excludeFixture"] as const;

export function ReviewActions(props: {
  readonly baselineId: string;
  readonly familyId: string;
  readonly returnTo: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}): ReactNode {
  if (props.disabled === true) {
    return (
      <div data-testid="family-actions-disabled">
        <p className="fr-muted">{props.disabledReason ?? "This baseline cannot be reviewed."}</p>
      </div>
    );
  }

  return (
    <div className="fr-row" data-testid="family-actions">
      {ROUTE_FAMILY.actions.map((label, index) => {
        const decision = DECISIONS[index] as (typeof DECISIONS)[number];
        return (
          <form action={decideRouteFamily} key={label}>
            <input name="baselineId" type="hidden" value={props.baselineId} />
            <input name="familyId" type="hidden" value={props.familyId} />
            <input name="returnTo" type="hidden" value={props.returnTo} />
            <input name="decision" type="hidden" value={decision} />
            <SubmitButton
              ghost={decision !== "approve"}
              pendingLabel="Recording…"
              testId={`family-${decision}`}
            >
              {label}
            </SubmitButton>
          </form>
        );
      })}
    </div>
  );
}
