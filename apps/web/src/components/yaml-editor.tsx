"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { SubmitButton } from "./submit-button";

/**
 * The Contract Studio's YAML editor (PRD Phase 13 task 8).
 *
 * A `<textarea>`, deliberately. CodeMirror and Monaco were both considered and rejected: each is a
 * large dependency needing a client-side YAML mode this product needs nowhere else, each brings its
 * own focus and keyboard model to re-audit, and neither can validate a FlightRules contract — only
 * the Phase 07 parser can, and it runs on the server. PRD Phase 13 asks for the smallest reliable
 * implementation, and the authority on whether a document is valid is the same either way.
 *
 * So what this component is responsible for is exactly the part a server render cannot do:
 *
 * - knowing whether the text differs from the document the server holds (dirty state);
 * - warning before a navigation that would discard an edit;
 * - not submitting the same save twice.
 *
 * It holds no contract semantics, parses nothing, and derives nothing about the contract. The
 * errors it renders were produced by the server-side validator and passed in.
 */

export interface EditorError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
  readonly line: number | null;
}

export function YamlEditor(props: {
  /** The document the server currently holds. The only source of the initial value. */
  readonly value: string;
  readonly contentHash: string;
  /** Server-produced validation errors for the stored document, if any. */
  readonly errors: readonly EditorError[];
  /** False once the contract has left `draft`; an immutable document is read-only. */
  readonly editable: boolean;
  readonly unsavedWarning: string;
  readonly saveAction: (formData: FormData) => void | Promise<void>;
}): ReactNode {
  const [text, setText] = useState(props.value);
  const stored = useRef(props.value);

  // The server document is the authority. When a save or a graph-control edit changes it, the
  // editor adopts the new text rather than keeping the stale draft the user was looking at.
  useEffect(() => {
    stored.current = props.value;
    setText(props.value);
  }, [props.value]);

  const dirty = text !== props.value;
  const textareaId = useId();
  const statusId = `${textareaId}-status`;
  const errorsId = `${textareaId}-errors`;

  // PRD Phase 13: "Do not silently discard edits during navigation."
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty]);

  const described = [statusId, props.errors.length > 0 ? errorsId : ""].filter(Boolean).join(" ");

  return (
    <form action={props.saveAction} className="fr-stack" data-testid="contract-yaml-form">
      <label className="fr-field__label" htmlFor={textareaId}>
        Contract YAML
      </label>
      <textarea
        aria-describedby={described}
        aria-invalid={props.errors.length > 0 ? true : undefined}
        className="fr-textarea"
        data-testid="contract-yaml-input"
        id={textareaId}
        name="yaml"
        onChange={(event) => {
          setText(event.target.value);
        }}
        readOnly={!props.editable}
        spellCheck={false}
        value={text}
        wrap="off"
      />

      <p className="fr-field__hint" data-testid="contract-yaml-status" id={statusId}>
        {props.editable
          ? dirty
            ? props.unsavedWarning
            : `Saved. Content hash ${props.contentHash}.`
          : "This version is immutable. Create a new draft to change it."}
      </p>

      {props.errors.length > 0 ? (
        <div
          className="fr-state fr-state--error"
          data-testid="contract-yaml-errors"
          id={errorsId}
          role="alert"
        >
          <p className="fr-state__title">
            {props.errors.length} validation {props.errors.length === 1 ? "error" : "errors"}
          </p>
          <ul className="fr-stack" style={{ marginTop: "var(--spacing-13)" }}>
            {props.errors.map((error) => (
              <li key={`${error.path}-${error.code}`}>
                <span className="fr-mono">
                  {error.line === null ? error.path : `${error.path} (line ${String(error.line)})`}
                </span>{" "}
                — {error.message} <span className="fr-mono fr-muted">{error.code}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {props.editable ? (
        <div className="fr-row">
          <SubmitButton pendingLabel="Saving…" testId="contract-yaml-save">
            Save document
          </SubmitButton>
          <button
            className="fr-button fr-button--ghost"
            data-testid="contract-yaml-reset"
            disabled={!dirty}
            onClick={() => {
              setText(stored.current);
            }}
            type="button"
          >
            Discard changes
          </button>
        </div>
      ) : null}
    </form>
  );
}
