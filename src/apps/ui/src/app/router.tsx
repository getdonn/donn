import { createBrowserRouter, Navigate } from "react-router";
import { AgentRoute } from "@/routes/agent";
import { AgentNewRoute } from "@/routes/agent-new";
import { AgentsRoute } from "@/routes/agents";
import { CapabilitiesRoute } from "@/routes/capabilities";
import { SessionsRoute } from "@/routes/sessions";
import { RegistryRoute } from "@/routes/registry";
import { PersonasRoute } from "@/routes/personas";
import { Shell } from "./shell";

// The app's routes: one per section of docs/planning/26-gui.md §3. The bridge serves
// index.html for any path, so these are real paths, not fragments.

export function createRouter() {
  return createBrowserRouter([
    {
      path: "/",
      element: <Shell />,
      children: [
        { index: true, element: <Navigate to="/projects" replace /> },
        { path: "projects", element: <PersonasRoute /> },
        { path: "sessions", element: <SessionsRoute /> },
        { path: "capabilities", element: <CapabilitiesRoute /> },
        { path: "registry", element: <RegistryRoute /> },
        { path: "agents", element: <AgentsRoute /> },
        { path: "agents/new", element: <AgentNewRoute /> },
        // Under `a/`: an agent the CLI named `new` is reachable too.
        { path: "agents/a/:name", element: <AgentRoute /> },
        { path: "*", element: <Navigate to="/projects" replace /> },
      ],
    },
  ]);
}
