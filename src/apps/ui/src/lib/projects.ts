import { useQuery } from "@tanstack/react-query";
import { useBridge } from "@/app/providers";

// The projects the daemon knows, shared by the shell's picker and the screens.

/** A project's folder name, for the picker; the full path is its title. */
export const folderName = (path: string) =>
  path.split("/").filter(Boolean).at(-1) ?? path;

/** The projects the daemon knows: `GET /v1/projects`. */
export function useProjects() {
  const bridge = useBridge();
  return useQuery({ queryKey: ["projects"], queryFn: () => bridge.projects() });
}
