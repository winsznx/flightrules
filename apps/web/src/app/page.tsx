import { DarkBand, Featured, Section } from "@flightrules/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { LANDING, PRODUCT_NAME } from "@/lib/copy";

/**
 * PRD section 8.1 — the public landing route.
 *
 * Every string is PRD section 8.1 verbatim, from `lib/copy.ts`. The one visual is a labelled
 * schematic of the real pipeline: PRD Phase 12 permits "clearly labelled illustrative diagrams" on
 * the landing route, and the caption says so in words rather than leaving a reader to assume it is
 * live data.
 *
 * The clay block appears once, on the final call to action — `design.md` allows one per page.
 */

const SCHEMATIC = `  instrumented agent ──▶ SigNoz (OTLP)
                              │
                              ▼
                     SigNoz MCP Server
                              │
                              ▼
       FlightRules ── graph ─ contract ─ evaluator
                              │
                              ▼
                     release gate  ──▶ exit 0 or 2`;

export default function LandingPage(): ReactNode {
  return (
    <div data-testid="route-landing">
      <div className="fr-shell">
        <section className="fr-landing-hero">
          <p className="fr-eyebrow">{LANDING.heroEyebrow}</p>
          <h1 className="fr-landing-hero__title" style={{ marginTop: "var(--spacing-22)" }}>
            {LANDING.heroTitle}
          </h1>
          <p className="fr-landing-hero__body">{LANDING.heroBody}</p>

          <div className="fr-row" style={{ marginTop: "var(--spacing-38)" }}>
            <Link className="fr-button" href="/demo">
              {LANDING.primaryCta}
            </Link>
            <Link className="fr-button fr-button--ghost" href="#architecture">
              {LANDING.secondaryCta}
            </Link>
          </div>

          <ul className="fr-proof" data-testid="proof-strip">
            {LANDING.proofStrip.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </div>

      <DarkBand testId="problem">
        <h2 className="fr-section-title" style={{ maxWidth: "24ch" }}>
          {LANDING.problemTitle}
        </h2>
        <p style={{ marginTop: "var(--spacing-22)", maxWidth: "62ch" }}>{LANDING.problemBody}</p>
      </DarkBand>

      <div className="fr-shell">
        <Section title="How it works" testId="mechanism">
          <ol className="fr-steps">
            {LANDING.mechanismSteps.map((step, index) => (
              <li key={step}>
                <span className="fr-muted" style={{ marginRight: "var(--spacing-15)" }}>
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </Section>

        <Section title={LANDING.secondaryCta} testId="architecture">
          <figure style={{ margin: 0 }} id="architecture">
            {/*
              At narrow widths the schematic scrolls horizontally, and a region that scrolls must be
              reachable by keyboard or its right-hand half cannot be read without a pointer. axe
              reports the absence as `scrollable-region-focusable`, serious. The scroll container is
              a labelled `section` rather than the `pre` itself, because `pre` has no ARIA role and
              therefore takes no accessible name.
            */}
            <section
              className="fr-schematic-scroll"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region is the documented case where a non-interactive element must be focusable (WCAG 2.1.1)
              tabIndex={0}
              aria-label="Architecture diagram of the FlightRules pipeline"
            >
              <pre className="fr-schematic" aria-describedby="architecture-caption">
                {SCHEMATIC}
              </pre>
            </section>
            <figcaption
              className="fr-muted"
              id="architecture-caption"
              style={{ marginTop: "var(--spacing-13)" }}
            >
              Illustrative diagram of the {PRODUCT_NAME} pipeline. It is not live data; every number
              in the authenticated product comes from the API.
            </figcaption>
          </figure>
        </Section>

        <Section testId="final-cta">
          <Featured title={LANDING.finalCtaTitle}>
            <Link className="fr-button" href="/demo">
              {LANDING.finalCtaButton}
            </Link>
          </Featured>
        </Section>
      </div>
    </div>
  );
}
