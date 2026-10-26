import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// A section whose screen is not built yet (docs/planning/26-gui.md §3).

export function Placeholder({
  title,
  about,
}: {
  title: string;
  about: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={1}>
          {title}
        </CardTitle>
        <CardDescription>{about}</CardDescription>
      </CardHeader>
    </Card>
  );
}
