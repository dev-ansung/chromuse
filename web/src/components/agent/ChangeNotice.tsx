import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { timeOf } from "@/lib/format";
import type { Notice } from "@/lib/documents-state";

type Props = { notice: Notice; canUndo: boolean; onUndo: () => void; onDismiss: () => void };

/** "Muse changed its soul" / "Muse updated MEMORY.md": every change the agent makes to its own documents is announced. */
export function ChangeNotice({ notice, canUndo, onUndo, onDismiss }: Props) {
  return (
    <Alert>
      <AlertTitle>{notice.soul ? "The agent changed its soul (SOUL.md)" : `The agent updated ${notice.path}`}</AlertTitle>
      <AlertDescription>
        <span>
          +{notice.added} −{notice.removed} lines · version {notice.version} · {timeOf(notice.at)}
        </span>
        <span className="mt-2 flex items-center gap-2">
          {canUndo ? (
            <Button variant="outline" size="xs" onClick={onUndo}>
              Undo
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={onDismiss}>
            Dismiss
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
