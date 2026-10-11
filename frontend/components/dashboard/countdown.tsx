"use client";

import { useCountdown } from "@/hooks/use-countdown";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export function Countdown({
  target,
  serverTime,
  label,
  onElapsed,
  className,
}: {
  target: string;
  serverTime?: string;
  label: string;
  onElapsed?: () => void;
  className?: string;
}) {
  const remaining = useCountdown(target, serverTime, onElapsed);
  return (
    <div className={cn("flex items-baseline gap-2", className)} role="timer" aria-live="off">
      <span className="t-eyebrow">{label}</span>
      <span className="tabular font-mono text-sm font-medium">{remaining === null ? "—" : formatDuration(remaining)}</span>
    </div>
  );
}
