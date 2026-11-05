import { useEffect } from "react";
import { BookOpenIcon, ChevronDownIcon, Trash2Icon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { deletePlaybook, loadPlaybooks, usePlaybooksState } from "@/lib/playbooks-store";
import type { Playbook } from "@/lib/agent-events";

function PlaybookItem({ playbook }: { playbook: Playbook }) {
  return (
    <Collapsible>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>{playbook.title}</ItemTitle>
          <ItemDescription>{playbook.situation}</ItemDescription>
          <div className="flex flex-wrap items-center gap-1">
            {playbook.hosts.map((host) => (
              <Badge key={host} variant="secondary">
                {host}
              </Badge>
            ))}
            <Badge variant="outline">
              worked {playbook.worked} · failed {playbook.failed}
            </Badge>
          </div>
          <CollapsibleContent>
            <ol className="mt-2 list-decimal pl-5 text-sm">
              {playbook.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            {playbook.pitfalls.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
                {playbook.pitfalls.map((pitfall, i) => (
                  <li key={i}>{pitfall}</li>
                ))}
              </ul>
            ) : null}
          </CollapsibleContent>
        </ItemContent>
        <ItemActions>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Show steps">
              <ChevronDownIcon data-icon />
            </Button>
          </CollapsibleTrigger>
          <Button variant="ghost" size="icon-sm" aria-label="Delete playbook" onClick={() => void deletePlaybook(playbook.id)}>
            <Trash2Icon data-icon />
          </Button>
        </ItemActions>
      </Item>
    </Collapsible>
  );
}

/** How the agent solved tasks before. The agent finds them by meaning, and shows only a pointer in its prompt. */
export function PlaybooksPanel() {
  const { status, items, error } = usePlaybooksState();

  useEffect(() => {
    void loadPlaybooks();
  }, []);

  return (
    <Card className="h-full min-h-0 rounded-none border-0">
      <CardHeader>
        <CardTitle>Playbooks</CardTitle>
        <CardDescription>How the agent solved tasks before. It looks them up when a new task looks similar, and keeps them out of its context otherwise.</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not reach the playbooks</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {status === "loading" && items.length === 0 ? <Spinner /> : null}
        {status === "ready" && items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpenIcon />
              </EmptyMedia>
              <EmptyTitle>No playbooks yet</EmptyTitle>
              <EmptyDescription>The agent saves one after a task that took trial and error, or when you ask it to remember how to do something.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        <ScrollArea className="min-h-0 flex-1">
          <ItemGroup className="gap-2">
            {items.map((playbook) => (
              <PlaybookItem key={playbook.id} playbook={playbook} />
            ))}
          </ItemGroup>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
