import { Global, Module } from "@nestjs/common";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { InternalAuthController } from "./internal-auth.controller";

@Global()
@Module({
  controllers: [InternalAuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
