import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { TutorAuthenticationError } from "../tutor/errors/tutor.errors";
import { AuthService } from "./auth.service";

export const AUTH_ERROR_STYLE_KEY = "authErrorStyle";
export type AuthErrorStyle = "standard" | "tutor";

export const AuthErrorFormat = (style: AuthErrorStyle) =>
  SetMetadata(AUTH_ERROR_STYLE_KEY, style);

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = await this.authService.getAuthenticatedUserId(req);

    if (!userId || userId.trim().length === 0) {
      const style =
        this.reflector.getAllAndOverride<AuthErrorStyle>(
          AUTH_ERROR_STYLE_KEY,
          [context.getHandler(), context.getClass()],
        ) ?? "standard";

      if (style === "tutor") {
        throw new TutorAuthenticationError();
      }
      throw new UnauthorizedException({ error: "Unauthorized" });
    }

    req.userId = userId;
    return true;
  }
}
