import type { ReactNode } from "react";
import { headers } from "next/headers";
import { viewerOf } from "../src/lib/viewer.ts";
import { Live } from "./live.tsx";
import "./tokens.css";
import "./globals.css";

export const dynamic = "force-dynamic";

const DARK = `if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.classList.add("dark");`;

export default async function Layout({ children }: { children: ReactNode }) {
  const viewer = viewerOf(await headers());
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: DARK }} />
      </head>
      <body>
        <header className="top">
          <a className="brand" href="/">
            Factory
          </a>
          <Live />
          {viewer.ok && viewer.name !== null ? <span className="viewer">{viewer.name}</span> : null}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
