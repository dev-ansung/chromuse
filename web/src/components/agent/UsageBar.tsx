import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tokens } from "@/lib/format";
import { useBrowserState } from "@/lib/browser-store";

/** Tokens used by the current run: totals in and out, and how big the last prompt was. Hidden until the first model call. */
export function UsageBar() {
  const { usage } = useBrowserState();
  if (usage.calls === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
      <Badge variant="secondary">{tokens(usage.input + usage.output)} tokens this run</Badge>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline">
            in {tokens(usage.input)} · out {tokens(usage.output)}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          Across {usage.calls} model call{usage.calls === 1 ? "" : "s"}.
          {usage.reasoning > 0 ? ` Reasoning is ${tokens(usage.reasoning)} of the output.` : ""}
          {usage.cached > 0 ? ` ${tokens(usage.cached)} input tokens were cached.` : ""}
        </TooltipContent>
      </Tooltip>
      <Badge variant="outline">context {tokens(usage.context)}</Badge>
    </div>
  );
}
