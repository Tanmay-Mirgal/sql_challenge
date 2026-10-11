import {
  CheckCircle2Icon,
  CircleDashedIcon,
  ClockIcon,
  FlagIcon,
  LockIcon,
  PlayCircleIcon,
  SendIcon,
  XCircleIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RoundAccess, RoundPhase } from "@/types/api";

const access: Record<RoundAccess, { label: string; icon: typeof LockIcon; className: string }> = {
  locked: { label: "Locked", icon: LockIcon, className: "border-border bg-transparent text-muted-foreground" },
  upcoming: { label: "Upcoming", icon: ClockIcon, className: "border-transparent bg-secondary text-secondary-foreground" },
  available: { label: "Available", icon: PlayCircleIcon, className: "border-transparent bg-foreground text-background" },
  in_progress: { label: "In progress", icon: CircleDashedIcon, className: "border-transparent bg-info/15 text-info" },
  submitted: { label: "Submitted", icon: SendIcon, className: "border-transparent bg-secondary text-secondary-foreground" },
  qualified: { label: "Qualified", icon: CheckCircle2Icon, className: "border-transparent bg-success/15 text-success" },
  eliminated: { label: "Eliminated", icon: XCircleIcon, className: "border-transparent bg-destructive/10 text-destructive" },
  completed: { label: "Completed", icon: FlagIcon, className: "border-transparent bg-secondary text-secondary-foreground" },
};

export function AccessBadge({ value, className }: { value: RoundAccess; className?: string }) {
  const { label, icon: Icon, className: tone } = access[value];
  return (
    <Badge variant="outline" className={cn("h-6 gap-1.5 px-2", tone, className)}>
      <Icon /> {label}
    </Badge>
  );
}

const phases: Record<RoundPhase, { label: string; className: string }> = {
  draft: { label: "Not published", className: "text-muted-foreground" },
  upcoming: { label: "Upcoming", className: "text-muted-foreground" },
  open: { label: "Live", className: "text-success" },
  paused: { label: "Paused", className: "text-warning" },
  closed: { label: "Closed", className: "text-muted-foreground" },
  finalized: { label: "Final", className: "text-foreground" },
};

export function PhaseLabel({ phase, className }: { phase: RoundPhase; className?: string }) {
  const { label, className: tone } = phases[phase];
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-[0.7rem] font-medium uppercase tracking-wider", tone, className)}>
      <span className={cn("size-1.5 rounded-full bg-current", phase === "open" && "animate-pulse")} aria-hidden="true" />
      {label}
    </span>
  );
}
