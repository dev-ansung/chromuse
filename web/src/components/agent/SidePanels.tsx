import { useEffect } from "react";
import { BrowserPanel } from "@/components/agent/BrowserPanel";
import { MemoryPanel } from "@/components/agent/MemoryPanel";
import { PlaybooksPanel } from "@/components/agent/PlaybooksPanel";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { documentsController } from "@/lib/documents";
import { useDocumentsState } from "@/lib/documents-store";

/** The bottom-right area: the Browser, Memory and Playbooks panels. Browser and Memory stay mounted so switching tabs loses nothing. */
export function SidePanels() {
  const { notices } = useDocumentsState();

  // Load the document list when the app opens, so changes made by the agent can be shown and undone from the start.
  useEffect(() => {
    void documentsController.load();
  }, []);

  return (
    <Tabs defaultValue="browser" className="h-full min-h-0 gap-0">
      <TabsList className="mx-3 mt-3 self-start">
        <TabsTrigger value="browser">Browser</TabsTrigger>
        <TabsTrigger value="memory">
          Memory
          {notices.length > 0 ? <Badge variant="secondary">{notices.length}</Badge> : null}
        </TabsTrigger>
        <TabsTrigger value="playbooks">Playbooks</TabsTrigger>
      </TabsList>
      <TabsContent value="browser" forceMount className="min-h-0 flex-1 data-[state=inactive]:hidden">
        <BrowserPanel />
      </TabsContent>
      <TabsContent value="memory" forceMount className="min-h-0 flex-1 data-[state=inactive]:hidden">
        <MemoryPanel />
      </TabsContent>
      <TabsContent value="playbooks" className="min-h-0 flex-1">
        <PlaybooksPanel />
      </TabsContent>
    </Tabs>
  );
}
