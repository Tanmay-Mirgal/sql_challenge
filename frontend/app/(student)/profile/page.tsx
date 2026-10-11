import type { Metadata } from "next";
import { ProfileForm } from "@/components/auth/profile-form";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { formatDate, initials } from "@/lib/format";
import { safeNextPath } from "@/lib/safe-redirect";

export const metadata: Metadata = { title: "Profile" };

const collegeLabel = {
  verified: "College e-mail verified",
  unverified: "Not a college e-mail",
  not_required: "College check not required",
} as const;

export default async function ProfilePage({ searchParams }: PageProps<"/profile">) {
  const { user } = await requireSession();
  const params = await searchParams;
  const from = params.from === "dashboard" ? safeNextPath("/dashboard") : undefined;

  return (
    <div className="page-container max-w-2xl space-y-6 py-8">
      <div>
        <h1 className="t-title">Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your identity comes from Google and can&apos;t be edited here.</p>
      </div>

      <Card>
        <CardContent className="flex items-center gap-4">
          <Avatar size="lg">
            {user.picture ? <AvatarImage src={user.picture} alt="" referrerPolicy="no-referrer" /> : null}
            <AvatarFallback>{initials(user.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{user.name}</p>
            <p className="truncate text-sm text-muted-foreground">{user.email}</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role === "admin" ? "Administrator" : "Participant"}</Badge>
            <span className="text-xs text-muted-foreground">{collegeLabel[user.collegeStatus]}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>College details</CardTitle>
          <CardDescription>Some events require these before you can register.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm user={user} redirectTo={from} />
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Member since {formatDate(user.createdAt)} · Last sign-in {formatDate(user.lastLoginAt)}
      </p>
    </div>
  );
}
