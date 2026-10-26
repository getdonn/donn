import { useSyncExternalStore } from "react";

// Light or dark from the system's `prefers-color-scheme`, as shadcn's `.dark` class on <html>,
// kept in step when the system setting changes. No toggle of the app's own.

const DARK = "(prefers-color-scheme: dark)";

export type ColorScheme = "light" | "dark";

const media = () => window.matchMedia(DARK);

const scheme = (): ColorScheme => (media().matches ? "dark" : "light");

function subscribe(listener: () => void): () => void {
  const query = media();
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** Sets `.dark` on `root` now and on every change; returns a function that stops. */
export function followColorScheme(
  root: HTMLElement = document.documentElement,
): () => void {
  const apply = () => root.classList.toggle("dark", scheme() === "dark");
  apply();
  return subscribe(apply);
}

/** The system's scheme, for components that pass it on (the toaster). */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, scheme, () => "light");
}
