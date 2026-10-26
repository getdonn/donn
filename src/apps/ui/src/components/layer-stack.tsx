import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useBridge } from "@/app/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { layerFile, layerKind } from "@/lib/explain";

// The layers of a persona in merge order (org → area → team → project → user), each with
// "Open in editor" (`POST /v1/open`).

export function LayerStack({
  layers,
  project,
  files,
}: {
  layers: string[];
  project: string;
  /** The file of each layer ref that `donn list` reported. */
  files: Record<string, string>;
}) {
  const bridge = useBridge();
  const open = useMutation({
    mutationFn: (path: string) => bridge.open(path),
    onSuccess: () => toast.success("Opened in your editor"),
  });
  return (
    <ol aria-label="Layers" className="divide-y rounded-md border">
      {layers.map((ref) => {
        const file = layerFile(ref, project, files);
        return (
          <li key={ref} className="flex items-center gap-3 px-3 py-1.5">
            <Badge variant="outline">{layerKind(ref)}</Badge>
            <span className="flex-1 font-mono text-sm">{ref}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={file === undefined || open.isPending}
              title={
                file === undefined ? "No file is known for this layer" : file
              }
              onClick={() => file !== undefined && open.mutate(file)}
            >
              Open in editor
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
