import Link from "next/link";
import { cn } from "@/lib/utils";

export function Logo({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2 font-mono text-sm font-semibold tracking-tight", className)} aria-label="SQL Arena home">
      <span className="grid size-6 place-items-center rounded-md bg-foreground text-background">
        <span className="text-[0.7rem] leading-none">&gt;_</span>
      </span>
      <span>
        sql<span className="text-muted-foreground">/</span>arena
      </span>
    </Link>
  );
}
