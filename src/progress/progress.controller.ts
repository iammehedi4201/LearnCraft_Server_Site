import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AuthErrorFormat, AuthGuard } from "../auth/auth.guard";
import { CurrentUserId } from "../auth/current-user.decorator";
import { ProgressService } from "./progress.service";

@Controller("progress")
@UseGuards(AuthGuard)
@AuthErrorFormat("standard")
export class ProgressController {
  constructor(
    @Inject(ProgressService) private readonly progressService: ProgressService,
  ) {}

  @Get()
  async getProgress(@CurrentUserId() userId: string) {
    return this.progressService.listUserProgress(userId);
  }

  @Post()
  @HttpCode(200)
  async saveProgress(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    return this.progressService.saveUserProgress(userId, body);
  }
}
