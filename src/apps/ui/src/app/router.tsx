import { createBrowserRouter, Navigate } from "react-router";
import { Placeholder } from "@/routes/placeholder";
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
        {
          path: "sessions",
          element: (
            <Placeholder
              title="Sessions"
              about="Live sessions per harness, and switching with its report."
            />
          ),
        },
        {
          path: "capabilities",
          element: (
            <Placeholder
              title="Capabilities"
              about="What each harness keeps and drops, and the compile reports."
            />
          ),
        },
        {
          path: "registry",
          element: (
            <Placeholder
              title="Registry"
              about="Sign in, who you are, pull and publish."
            />
          ),
        },
        {
          path: "agents",
          element: (
            <Placeholder
              title="Agents"
              about="Declared and created agents, and the builder."
            />
          ),
        },
        { path: "*", element: <Navigate to="/projects" replace /> },
      ],
    },
  ]);
}
