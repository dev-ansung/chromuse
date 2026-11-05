import { ChangeNotice } from "@/components/agent/ChangeNotice";
import { documentsController } from "@/lib/documents";
import { useDocumentsState } from "@/lib/documents-store";
import { canUndoNotice } from "@/lib/documents-state";

/** Changes the agent made to SOUL.md, shown above the chat until dismissed: the soul file itself says "tell the user". */
export function SoulNotice() {
  const state = useDocumentsState();
  const soulNotices = state.notices.filter((n) => n.soul);
  if (soulNotices.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 p-3">
      {soulNotices.map((notice) => (
        <ChangeNotice
          key={notice.id}
          notice={notice}
          canUndo={canUndoNotice(state, notice)}
          onUndo={() => void documentsController.undoNotice(notice)}
          onDismiss={() => documentsController.dismissNotice(notice.id)}
        />
      ))}
    </div>
  );
}
