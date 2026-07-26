import type { ReactNode } from "react";

/**
 * The product's UI primitives (PRD Phase 12 task 4).
 *
 * Every component renders `design.md`'s vocabulary and nothing else: a card is a hairline above a
 * title, a button is a pill, a featured block is the one hard-edged clay rectangle. None of them
 * takes a colour, a size or a spacing value as a prop, because a caller that could pass one could
 * invent a design value the system does not define.
 *
 * All of them are server-renderable. The web application holds no SigNoz credential and makes no
 * MCP call (PRD section 12.3), so nothing here needs client state.
 */

export interface WithChildren {
  readonly children?: ReactNode | undefined;
}

export interface TestId {
  /** Stable selector for the route and end-to-end suites (PRD Phase 12 task 9). */
  readonly testId?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* Page furniture                                                             */
/* -------------------------------------------------------------------------- */

export function PageHeader(props: {
  readonly eyebrow?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: ReactNode | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <header className="fr-page-header" data-testid={props.testId ?? "page-header"}>
      {props.eyebrow === undefined ? null : <p className="fr-eyebrow">{props.eyebrow}</p>}
      <h1 className="fr-page-title" style={{ marginTop: "var(--spacing-15)" }}>
        {props.title}
      </h1>
      {props.description === undefined ? null : (
        <p className="fr-page-header__meta">{props.description}</p>
      )}
      {props.actions === undefined ? null : (
        <div className="fr-row" style={{ marginTop: "var(--spacing-22)" }}>
          {props.actions}
        </div>
      )}
    </header>
  );
}

export function Section(props: {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <section className="fr-section" data-testid={props.testId}>
      {props.title === undefined ? null : <h2 className="fr-section-title">{props.title}</h2>}
      {props.description === undefined ? null : (
        <p className="fr-muted" style={{ marginTop: "var(--spacing-15)" }}>
          {props.description}
        </p>
      )}
      <div style={{ marginTop: "var(--spacing-31)" }}>{props.children}</div>
    </section>
  );
}

export function Card(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <article className="fr-card" data-testid={props.testId}>
      <h3 className="fr-block-title">{props.title}</h3>
      <div style={{ marginTop: "var(--spacing-13)" }}>{props.children}</div>
    </article>
  );
}

/**
 * The single clay block. `design.md`: "Don't place two #bc7155 elements on the same page".
 * One per route, reserved for the thing the page exists to say.
 */
export function Featured(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <article className="fr-featured" data-testid={props.testId ?? "featured"}>
      <h2 className="fr-section-title">{props.title}</h2>
      <div style={{ marginTop: "var(--spacing-22)" }}>{props.children}</div>
    </article>
  );
}

export function DarkBand(props: WithChildren & TestId): ReactNode {
  return (
    <section className="fr-dark" data-testid={props.testId}>
      <div className="fr-shell">{props.children}</div>
    </section>
  );
}

export function Stat(props: {
  readonly label: string;
  readonly value: string;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <div className="fr-stat" data-testid={props.testId}>
      <span className="fr-stat__value">{props.value}</span>
      <span className="fr-stat__label">{props.label}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A status is a word, never a colour (PRD section 20.3, ADR-0011).
 *
 * `emphasis` thickens the border for a decision that matters; it never changes the hue, so a
 * monochrome or colour-blind reading loses nothing.
 */
export function Status(props: {
  readonly label: string;
  readonly emphasis?: boolean | undefined;
  readonly inverse?: boolean | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  const classes = ["fr-status"];
  if (props.emphasis === true) classes.push("fr-status--strong");
  if (props.inverse === true) classes.push("fr-status--inverse");
  return (
    <span className={classes.join(" ")} data-testid={props.testId ?? "status"}>
      {props.label.toUpperCase()}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Data display                                                               */
/* -------------------------------------------------------------------------- */

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly numeric?: boolean | undefined;
  readonly render: (row: T) => ReactNode;
}

/**
 * A table with a caption, a scroll container and a declared empty state.
 *
 * The caption is required rather than optional: a screen reader announces it, and a table that does
 * not say what it lists is unusable without sight of the heading above it.
 */
export function Table<T>(props: {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly empty: ReactNode;
  readonly testId?: string | undefined;
}): ReactNode {
  if (props.rows.length === 0) return props.empty;
  return (
    // A container that scrolls must be reachable by keyboard, or a keyboard-only user cannot see
    // the columns beyond the fold. axe reports this as `scrollable-region-focusable`, serious. The
    // region is labelled with the caption so a screen reader announces what it is about to scroll
    // rather than "group".
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region is exactly the case
    // where a non-interactive element must be focusable (WCAG 2.1.1).
    <div className="fr-table-scroll" tabIndex={0} role="region" aria-label={props.caption}>
      <table className="fr-table" data-testid={props.testId}>
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric === true ? "fr-numeric" : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={props.rowKey(row)}>
              {props.columns.map((column) => (
                <td key={column.key} className={column.numeric === true ? "fr-numeric" : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function KeyValues(props: {
  readonly entries: readonly (readonly [string, ReactNode])[];
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <dl className="fr-dl" data-testid={props.testId}>
      {props.entries.map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/* States (PRD Phase 12 task 10)                                              */
/* -------------------------------------------------------------------------- */

export function EmptyState(props: {
  readonly title: string;
  readonly body?: string | undefined;
  readonly action?: ReactNode | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <div className="fr-state" data-testid={props.testId ?? "empty-state"}>
      <p className="fr-state__title">{props.title}</p>
      {props.body === undefined ? null : <p className="fr-state__body">{props.body}</p>}
      {props.action === undefined ? null : (
        <div style={{ marginTop: "var(--spacing-22)" }}>{props.action}</div>
      )}
    </div>
  );
}

/**
 * A failure the user has to see.
 *
 * `role="alert"` so it is announced, and the code is shown: PRD section 19's codes are part of the
 * product's contract, and an operator who can quote one gets help faster than one who can only
 * describe a red box.
 */
export function ErrorState(props: {
  readonly title: string;
  readonly detail: string;
  readonly code?: string | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <div
      className="fr-state fr-state--error"
      role="alert"
      data-testid={props.testId ?? "error-state"}
    >
      <p className="fr-state__title">{props.title}</p>
      <p className="fr-state__body">{props.detail}</p>
      {props.code === undefined ? null : (
        <p className="fr-mono fr-muted" style={{ marginTop: "var(--spacing-11)" }}>
          {props.code}
        </p>
      )}
    </div>
  );
}

/** A dependency that is reachable but not fully working — PRD section 15.1 allows SigNoz to be so. */
export function DegradedState(props: {
  readonly title: string;
  readonly detail: string;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <div className="fr-state" role="status" data-testid={props.testId ?? "degraded-state"}>
      <p className="fr-state__title">{props.title}</p>
      <p className="fr-state__body">{props.detail}</p>
    </div>
  );
}

export function SuccessState(props: {
  readonly message: string;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <p className="fr-toast" role="status" data-testid={props.testId ?? "success-state"}>
      {props.message}
    </p>
  );
}

export function Skeleton(props: {
  readonly rows?: number | undefined;
  readonly testId?: string;
}): ReactNode {
  const rows = props.rows ?? 3;
  return (
    <div
      className="fr-stack"
      aria-hidden="true"
      data-testid={props.testId ?? "skeleton"}
      style={{ gap: "var(--spacing-13)" }}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={`skeleton-${String(index)}`} className="fr-skeleton" />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Forms                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A labelled control with its error explicitly associated.
 *
 * PRD section 20.3 requires "forms have explicit labels and error associations". `aria-describedby`
 * and `aria-invalid` are set here rather than left to each call site, because a call site that
 * forgets produces a field a screen reader reports as valid while the page says otherwise.
 */
export function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: (attributes: {
    readonly id: string;
    readonly "aria-describedby": string | undefined;
    readonly "aria-invalid": boolean | undefined;
  }) => ReactNode;
}): ReactNode {
  const hintId = props.hint === undefined ? undefined : `${props.id}-hint`;
  const errorId = props.error === undefined ? undefined : `${props.id}-error`;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="fr-field">
      <label className="fr-field__label" htmlFor={props.id}>
        {props.label}
      </label>
      {props.children({
        id: props.id,
        "aria-describedby": describedBy,
        "aria-invalid": props.error === undefined ? undefined : true,
      })}
      {props.hint === undefined ? null : (
        <p className="fr-field__hint" id={hintId}>
          {props.hint}
        </p>
      )}
      {props.error === undefined ? null : (
        <p className="fr-field__error" id={errorId}>
          {props.error}
        </p>
      )}
    </div>
  );
}

export function Dialog(props: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <dialog className="fr-dialog" id={props.id} aria-labelledby={`${props.id}-title`}>
      <h2 className="fr-block-title" id={`${props.id}-title`}>
        {props.title}
      </h2>
      <div style={{ marginTop: "var(--spacing-15)" }}>{props.children}</div>
    </dialog>
  );
}
