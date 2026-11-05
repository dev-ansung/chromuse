import { InfoIcon, SaveIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { docInfo } from "@/lib/doc-info";
import { documentsController } from "@/lib/documents";
import { isDirty } from "@/lib/documents-state";
import { useDocumentsState } from "@/lib/documents-store";
import { timeOf } from "@/lib/format";

export function DocumentEditor() {
  const s = useDocumentsState();
  if (!s.path) return null;
  const dirty = isDirty(s);

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 pr-3 pb-3">
        <Alert>
          <InfoIcon />
          <AlertDescription>{docInfo(s.path)}</AlertDescription>
        </Alert>

        {s.error ? (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{s.error}</AlertDescription>
          </Alert>
        ) : null}

        {s.changedUnderneath && !s.conflict ? (
          <Alert>
            <AlertTitle>The agent changed this file</AlertTitle>
            <AlertDescription>You have unsaved edits. When you save, you will be asked how to combine them; nothing is overwritten silently.</AlertDescription>
          </Alert>
        ) : null}

        {s.conflict ? (
          <Alert variant="destructive">
            <AlertTitle>The agent updated this file while you were editing</AlertTitle>
            <AlertDescription>
              <span>Your save was not applied. Keeping your version would change {s.conflict.diff.added + s.conflict.diff.removed} line(s) of the agent's current version:</span>
              <span className="mt-2 flex max-h-40 flex-col overflow-auto rounded-md border p-2 font-mono text-xs">
                {s.conflict.diff.lines.map((line, i) => (
                  <span key={i} className={line.op === "-" ? "text-destructive" : line.op === "+" ? "text-primary" : "text-muted-foreground"}>
                    {line.op} {line.text}
                  </span>
                ))}
              </span>
              <span className="mt-2 flex items-center gap-2">
                <Button variant="outline" size="xs" onClick={() => void documentsController.keepMine()}>
                  Keep mine
                </Button>
                <Button variant="outline" size="xs" onClick={() => void documentsController.takeTheirs()}>
                  Take theirs
                </Button>
                <Button variant="ghost" size="xs" onClick={() => documentsController.cancelConflict()}>
                  Keep editing
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}

        {s.warnings.map((w, i) => (
          <Alert key={i}>
            <AlertTitle>Saved, with a warning</AlertTitle>
            <AlertDescription>
              {w.code === "secret"
                ? `This looks like it contains a secret (${w.kinds.join(", ")}). The agent reads this file in every conversation.`
                : `This file is ${w.chars} characters, over the ${w.max} limit for the agent's own edits. Part of it may be left out of the agent's prompt.`}
            </AlertDescription>
          </Alert>
        ))}

        {s.loading || !s.doc ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="document-editor" className="sr-only">
                {s.path}
              </FieldLabel>
              <Textarea id="document-editor" className="min-h-48 font-mono text-sm" value={s.draft} onChange={(e) => documentsController.edit(e.target.value)} />
              <FieldDescription>
                Version {s.doc.version} · last changed by {s.doc.updatedBy ?? "unknown"} · {timeOf(s.doc.updatedAt)}
              </FieldDescription>
            </Field>
          </FieldGroup>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void documentsController.save()} disabled={!dirty || s.saving || s.loading}>
            {s.saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            Save
          </Button>
          <Button variant="outline" size="sm" onClick={() => documentsController.revertDraft()} disabled={!dirty}>
            Revert
          </Button>
        </div>

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              History ({s.history.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ItemGroup>
              {s.history.map((v) => (
                <Item key={v.version} size="sm" variant="outline">
                  <ItemContent>
                    <ItemTitle>
                      Version {v.version} · {v.updatedBy}
                      {v.undoOf ? ` (restored version ${v.undoOf})` : ""}
                    </ItemTitle>
                    <ItemDescription>
                      +{v.added} −{v.removed} · {timeOf(v.updatedAt)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button variant="outline" size="xs" disabled={dirty || s.saving || v.version === s.doc?.version} onClick={() => void documentsController.restore(v.version)}>
                      Restore
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </ScrollArea>
  );
}
