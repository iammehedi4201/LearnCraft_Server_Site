import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthService, verifyInternalAuthSignature } from "./auth.service";

interface AdapterRequestBody {
  op: string;
  payload: Record<string, unknown>;
}

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller("internal/auth")
export class InternalAuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("adapter")
  @HttpCode(200)
  async handleAdapter(
    @Req() req: RawBodyRequest,
    @Body() body: AdapterRequestBody,
    @Headers("x-internal-auth-signature") signature?: string,
    @Headers("x-internal-auth-timestamp") timestamp?: string,
  ) {
    const secret = process.env.AUTH_SECRET?.trim() || "";
    const payloadText = req.rawBody
      ? req.rawBody.toString("utf8")
      : JSON.stringify(body ?? {});

    const valid = verifyInternalAuthSignature({
      payloadText,
      timestamp: timestamp || "",
      signature: signature || "",
      secret,
    });

    if (!valid) {
      throw new UnauthorizedException({
        error: "Invalid internal auth signature",
      });
    }

    return this.authService.handleAdapterOperation(
      body?.op,
      body?.payload ?? {},
    );
  }
}
