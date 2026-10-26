// First: before @getdonn/cli-schemas builds its schemas.
import "./lib/jitless";
import { StrictMode, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { SessionEnded } from "./app/ended";
import { AppProviders, createClients } from "./app/providers";
import { createRouter } from "./app/router";
import { createSession, type Session } from "./lib/session";
import { followColorScheme } from "./lib/theme";
import "./styles.css";

// The app's entry: sign in (lib/session.ts), then the shell over the bridge; once the session
// ends, only the ended screen.

followColorScheme();
const session = createSession();
void session.start();

function App({ session }: { session: Session }) {
  const state = useSyncExternalStore(session.subscribe, session.current);
  if (state.state === "starting") return null;
  if (state.state === "ended") return <SessionEnded reason={state.reason} />;
  return <Signed session={session} />;
}

function Signed({ session }: { session: Session }) {
  const clients = useMemo(() => createClients(session), [session]);
  const router = useMemo(() => createRouter(), []);
  return (
    <AppProviders clients={clients} session={session}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
);
