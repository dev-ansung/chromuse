import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { LiveView } from "@/components/agent/LiveView";
import { SidePanels } from "@/components/agent/SidePanels";
import { UsageBar } from "@/components/agent/UsageBar";
import { SoulNotice } from "@/components/agent/SoulNotice";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentRuntime } from "@/lib/use-agent-runtime";

export default function App() {
  const runtime = useAgentRuntime();

  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        {/* The panel group sets height:100% inline, so its parent must have a definite height or nothing is bounded. */}
        <div className="h-dvh">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="45%" minSize="30%">
              <div className="flex h-full min-h-0 flex-col">
              <UsageBar />
              <SoulNotice />
              <div className="min-h-0 flex-1">
                <Thread />
              </div>
            </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="55%" minSize="30%">
              <ResizablePanelGroup orientation="vertical">
                <ResizablePanel defaultSize="55%" minSize="20%">
                  <LiveView />
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize="45%" minSize="20%">
                  <SidePanels />
                </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
