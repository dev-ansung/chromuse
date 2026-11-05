import { CameraIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { screenshotView, type Frame } from "@/lib/browser-state";
import { dispatch, useBrowserState } from "@/lib/browser-store";
import { hostOf, timeOf } from "@/lib/format";
import { liveDriver } from "@/lib/live";

const describe = (frame: Frame) => (frame.source.kind === "step" ? `after ${frame.source.tool}` : `snapshot · ${hostOf(frame.source.url)}`);

export function LiveView() {
  const state = useBrowserState();
  const { shot, position, total, canPrev, canNext, live } = screenshotView(state);

  return (
    <Card className="h-full min-h-0 rounded-none border-0">
      <CardHeader>
        <CardTitle>Live view</CardTitle>
        <CardDescription>
          {shot ? `${position} / ${total} · ${describe(shot)} · ${timeOf(shot.takenAt)}` : "Updates after each action the agent takes. Use the camera to see the page now."}
        </CardDescription>
        <CardAction className="flex items-center gap-1">
          {shot ? <Badge variant={live ? "default" : "outline"}>{live ? "latest" : "history"}</Badge> : null}
          <Button variant="outline" size="icon-sm" aria-label="Take a screenshot now" disabled={state.live.inflight} onClick={() => void liveDriver.snap()}>
            {state.live.inflight ? <Spinner /> : <CameraIcon />}
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Previous screenshot" disabled={!canPrev} onClick={() => dispatch({ type: "screenshot_prev" })}>
            <ChevronLeftIcon />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next screenshot" disabled={!canNext} onClick={() => dispatch({ type: "screenshot_next" })}>
            <ChevronRightIcon />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Latest screenshot" disabled={live} onClick={() => dispatch({ type: "screenshot_latest" })}>
            <ChevronsRightIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {shot ? (
          <img
            className="size-full rounded-md border object-contain object-top"
            src={`data:${shot.mime};base64,${shot.data}`}
            alt={`The browser ${describe(shot)} (${position} of ${total})`}
          />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CameraIcon />
              </EmptyMedia>
              <EmptyTitle>No screenshot yet</EmptyTitle>
              <EmptyDescription>A screenshot appears after each action the agent takes. The camera takes one of the selected tab right now.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}
