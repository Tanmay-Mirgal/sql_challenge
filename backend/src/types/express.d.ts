import type { ISession } from "@/modules/auth/session.model";
import type { UserDocument } from "@/modules/users/user.model";
import type { HydratedDocument } from "mongoose";

declare global {
  namespace Express {
    interface AuthContext {
      user: UserDocument;
      session: HydratedDocument<ISession>;
      /** Raw bearer value from the cookie (never persisted or logged). */
      sessionToken: string;
    }
    interface Request {
      /** Correlation id echoed in logs and the `x-request-id` response header. */
      id: string;
      auth?: AuthContext;
    }
  }
}

export {};
