"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api-client";
import { type ProfileFormValues, profileSchema } from "@/lib/validations/profile";
import { useAuthStore } from "@/stores/auth-store";
import type { SelfUser } from "@/types/api";

export function ProfileForm({ user, redirectTo }: { user: SelfUser; redirectTo?: string }) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { rollNumber: user.rollNumber ?? "", department: user.department ?? "" },
  });

  async function onSubmit(values: ProfileFormValues) {
    try {
      const { user: updated } = await api.patch<{ user: SelfUser }>("/me/profile", {
        rollNumber: values.rollNumber,
        department: values.department,
      });
      useAuthStore.getState().setUser(updated);
      toast.success("Profile saved.");
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch (error) {
      toast.error(errorMessage(error, "Could not save your profile."));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <div className="space-y-2">
        <Label htmlFor="rollNumber">Roll number</Label>
        <Input id="rollNumber" autoComplete="off" aria-invalid={Boolean(errors.rollNumber)} aria-describedby="rollNumber-error" {...register("rollNumber")} />
        {errors.rollNumber ? (
          <p id="rollNumber-error" role="alert" className="text-xs text-destructive">
            {errors.rollNumber.message}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="department">Department</Label>
        <Input id="department" autoComplete="off" placeholder="e.g. Computer Engineering" aria-invalid={Boolean(errors.department)} aria-describedby="department-error" {...register("department")} />
        {errors.department ? (
          <p id="department-error" role="alert" className="text-xs text-destructive">
            {errors.department.message}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">Shown next to your name on the leaderboard.</p>
      </div>
      <Button type="submit" disabled={isSubmitting || !isDirty} className="h-9">
        {isSubmitting ? <Loader2Icon className="animate-spin" /> : null} Save changes
      </Button>
    </form>
  );
}
