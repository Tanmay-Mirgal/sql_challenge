import { Logo } from "@/components/brand/logo";
import { NavLinks } from "@/components/layout/nav-links";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import type { SelfUser } from "@/types/api";

export function SiteHeader({ user }: { user: SelfUser }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="page-container flex h-14 items-center justify-between gap-4">
        <div className="flex items-center gap-4 sm:gap-6">
          <Logo href="/dashboard" />
          <NavLinks isAdmin={user.role === "admin"} />
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <UserMenu user={user} />
        </div>
      </div>
    </header>
  );
}
