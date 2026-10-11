import type { Metadata } from "next";
import { CalendarClockIcon, ServerCrashIcon } from "lucide-react";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { serverApi } from "@/lib/api-server";
import { requireSession } from "@/lib/auth";
import type { Dashboard } from "@/types/api";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const { user } = await requireSession();
  const { data, error } = await serverApi<{ dashboard: Dashboard | null }>("/me/dashboard");

  if (error) {
    return (
      <div className="page-container py-10">
        <Alert variant="destructive">
          <ServerCrashIcon />
          <AlertTitle>Could not load the dashboard</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!data?.dashboard) {
    return (
      <div className="page-container grid flex-1 place-items-center py-16">
        <div className="max-w-sm space-y-3 text-center">
          <CalendarClockIcon className="mx-auto size-8 text-muted-foreground" />
          <h1 className="t-title">No event is running yet</h1>
          <p className="text-sm text-muted-foreground">
            The organisers haven&apos;t opened an event. Check back soon — your account is ready.
          </p>
        </div>
      </div>
    );
  }
  return <DashboardView initial={data.dashboard} user={user} />;
}
