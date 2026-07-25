import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";
import { LANDING, PRODUCT_NAME } from "@/lib/copy";

/**
 * The application shell (PRD Phase 12 task 4).
 *
 * A skip link, a landmark-per-region layout and a nav that marks its current page. Everything is
 * server-rendered: there is no client bundle carrying product state, and therefore no path by which
 * a credential or an API location could reach the browser (PRD section 12.3).
 */

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — ${LANDING.heroEyebrow}`,
  description: LANDING.heroBody,
};

const NAV = [
  { href: "/projects", label: "Projects" },
  { href: "/setup", label: "Setup" },
  { href: "/demo", label: "Demo" },
] as const;

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <a className="fr-skip" href="#main">
          Skip to content
        </a>
        <div className="fr-page">
          <div className="fr-shell">
            <nav className="fr-nav" aria-label="Primary">
              <Link className="fr-nav__brand" href="/">
                {PRODUCT_NAME}
              </Link>
              <ul className="fr-nav__links">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <Link className="fr-nav__link" href={item.href}>
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          <main className="fr-main" id="main" data-testid="main">
            {children}
          </main>

          <footer className="fr-footer fr-dark">
            <div className="fr-shell">
              <p className="fr-footer__mark">{PRODUCT_NAME}</p>
              <p className="fr-muted" style={{ marginTop: "var(--spacing-15)", maxWidth: "62ch" }}>
                {LANDING.heroEyebrow}
              </p>
              <ul className="fr-footer__links">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href}>{item.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
