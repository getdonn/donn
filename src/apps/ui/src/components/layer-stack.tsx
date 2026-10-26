import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useBridge } from "@/app/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { layerKind, openTarget } from "@/lib/explain";

// The layers of a persona in merge order (org → area → team → project → user), each with
// "Open in editor" (`POST /v1/open`).

export function LayerStack({
  layers,
  project,
  files,
  published,
}: {
  layers: string[];
  project: string;
  /** The file of each layer ref that `donn list` reported. */
  files: Record<string, string>;
  /** The refs that resolve from the registry cache: no file to open. */
  published: ReadonlySet<string>;
}) {
  const bridge = useBridge();
  const open = useMutation({
    mutationFn: (path: string) => bridge.open(path),
    onSuccess: () => toast.success("Opened in your editor"),
  });
  return (
    <ol aria-label="Layers" className="divide-y rounded-md border">
      {layers.map((ref) => {
        const target = openTarget(ref, project, files, published);
        return (
          <li key={ref} className="flex items-center gap-3 px-3 py-1.5">
            <Badge variant="outline">{layerKind(ref)}</Badge>
            <span className="flex-1 font-mono text-sm">{ref}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={target.file === undefined || open.isPending}
              title={target.file ?? target.title}
              onClick={() =>
                target.file !== undefined && open.mutate(target.file)
              }
            >
              Open in editor
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
