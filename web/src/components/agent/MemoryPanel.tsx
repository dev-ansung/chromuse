import { ChangeNotice } from "@/components/agent/ChangeNotice";
import { DocumentEditor } from "@/components/agent/DocumentEditor";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_FILE } from "@/lib/documents-controller";
import { documentsController } from "@/lib/documents";
import { canUndoNotice } from "@/lib/documents-state";
import { useDocumentsState } from "@/lib/documents-store";

const label = (path: string) => path.replace(/^notes\//, "").replace(/\.md$/, "");

export function MemoryPanel() {
  const state = useDocumentsState();
  const others = state.notices.filter((n) => !n.soul); // changes to SOUL.md are shown above the chat

  return (
    <Card className="h-full min-h-0 rounded-none border-0">
      <CardHeader>
        <CardTitle>Memory</CardTitle>
        <CardDescription>The agent's soul and memory. You and the agent can both edit them.</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <Tabs value={state.path ?? DEFAULT_FILE} onValueChange={(path) => void documentsController.open(path)}>
          <TabsList>
            {state.files.map((file) => (
              <TabsTrigger key={file.path} value={file.path}>
                {label(file.path)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {others.length > 0 ? (
          <div className="flex flex-col gap-2">
            {others.map((notice) => (
              <ChangeNotice
                key={notice.id}
                notice={notice}
                canUndo={canUndoNotice(state, notice)}
                onUndo={() => void documentsController.undoNotice(notice)}
                onDismiss={() => documentsController.dismissNotice(notice.id)}
              />
            ))}
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          <DocumentEditor />
        </div>
      </CardContent>
    </Card>
  );
}
