import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CliFailure } from "@/lib/bridge";
import { ErrorText } from "./error-text";

// The one renderer of a failure shown inline: the message, the CLI's fix as its own element
// (never run into the message), and the code when there is no message.

/** The rendered alert, as a DOM element. */
function render(error: unknown): HTMLElement | null {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ErrorText error={error} />);
  return host.querySelector("[role=alert]");
}

const parts = (alert: HTMLElement | null) =>
  [...(alert?.children ?? [])].map((child) => child.textContent);

describe("ErrorText", () => {
  it("shows the message, then the fix as a separate element", () => {
    const alert = render(
      new CliFailure("secret-unresolved", "no shell environment", {
        fix: "run donn agent run box from a terminal",
      }),
    );
    expect(parts(alert)).toEqual([
      "no shell environment",
      "run donn agent run box from a terminal",
    ]);
    // Read as text (a screen reader, Playwright), the two do not run together.
    expect(alert?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "no shell environment run donn agent run box from a terminal",
    );
  });

  it("shows the code when there is no message", () => {
    const alert = render(new CliFailure("missing-ref", ""));
    expect(parts(alert)).toEqual(["missing-ref"]);
  });

  it("shows any other error's message, and nothing for none", () => {
    expect(parts(render(new Error("boom")))).toEqual(["boom"]);
    expect(parts(render("plain"))).toEqual(["plain"]);
    expect(render(undefined)).toBeNull();
    expect(render(null)).toBeNull();
  });
});

/** The screens' sources, by path from src/. */
const SOURCES = import.meta.glob<string>(
  ["../app/*.tsx", "../routes/*.tsx", "./*.tsx", "!./*.test.tsx"],
  { query: "?raw", import: "default", eager: true },
);

describe("the screens", () => {
  it("render a failure inline through ErrorText, never its message by hand", () => {
    const files = Object.fromEntries(
      Object.entries(SOURCES).map(([path, text]) => [
        path.replace(/^\.\.\//, "").replace(/^\.\//, "components/"),
        text,
      ]),
    );
    expect(Object.keys(files)).toContain("routes/registry.tsx");
    // The toasts (app/providers.tsx) are the one other place a failure is shown.
    const allowed = ["components/error-text.tsx", "app/providers.tsx"];
    const offenders = Object.entries(files)
      .filter(
        ([file, text]) =>
          !allowed.includes(file) &&
          /\b(error|failure)\.message\b|function ErrorText\b/.test(text),
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
