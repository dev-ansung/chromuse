import { useEffect } from "react";
import { AppWindowIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBrowserState } from "@/lib/browser-store";
import { connectBrowser } from "@/lib/connect";

const STATUS_VARIANT = { idle: "outline", connecting: "secondary", connected: "default", error: "destructive" } as const;

export function BrowserPanel() {
  const { connection, tabs, warnings, runError } = useBrowserState();

  // Attach and list the tabs as soon as the page opens, before any message is sent.
  useEffect(() => {
    void connectBrowser();
  }, []);

  const problems = (runError ? 1 : 0) + warnings.length;

  return (
    <Card className="h-full min-h-0 rounded-none border-0">
      <CardHeader>
        <CardTitle>Browser</CardTitle>
        <CardDescription>Your running Chrome, read before any model call.</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[connection.status]}>{connection.status}</Badge>
          <Button variant="outline" size="sm" onClick={() => void connectBrowser()} disabled={connection.status === "connecting"}>
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        <Tabs defaultValue="tabs" className="h-full min-h-0">
          <TabsList>
            <TabsTrigger value="tabs">Tabs ({tabs.length})</TabsTrigger>
            <TabsTrigger value="problems">Problems ({problems})</TabsTrigger>
          </TabsList>

          <TabsContent value="tabs" className="min-h-0 flex-1">
            {connection.status === "error" ? (
              <Alert variant="destructive">
                <AlertTitle>Could not attach to Chrome</AlertTitle>
                <AlertDescription>
                  {connection.error}
                  {connection.hint ? ` ${connection.hint}` : ""}
                </AlertDescription>
              </Alert>
            ) : tabs.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <AppWindowIcon />
                  </EmptyMedia>
                  <EmptyTitle>{connection.status === "connected" ? "No tabs are open" : "Not connected yet"}</EmptyTitle>
                  <EmptyDescription>
                    {connection.status === "connected" ? "Open a tab in Chrome and press Refresh." : "Waiting for the browser."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ScrollArea className="h-full">
                <ItemGroup>
                  {tabs.map((tab) => (
                    <Item key={tab.id} size="sm" variant="outline">
                      <ItemContent>
                        <ItemTitle>
                          {tab.id}: {tab.title || tab.url}
                        </ItemTitle>
                        {tab.title ? <ItemDescription>{tab.url}</ItemDescription> : null}
                      </ItemContent>
                      {tab.selected ? (
                        <ItemActions>
                          <Badge variant="secondary">selected</Badge>
                        </ItemActions>
                      ) : null}
                    </Item>
                  ))}
                </ItemGroup>
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="problems" className="min-h-0 flex-1">
            {problems === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No problems</EmptyTitle>
                  <EmptyDescription>Run errors and warnings appear here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-2">
                  {runError ? (
                    <Alert variant="destructive">
                      <AlertTitle>The run failed</AlertTitle>
                      <AlertDescription>{runError}</AlertDescription>
                    </Alert>
                  ) : null}
                  {warnings.map((message, i) => (
                    <Alert key={i}>
                      <AlertDescription>{message}</AlertDescription>
                    </Alert>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
