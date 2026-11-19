import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { AuthErrorFormat, AuthGuard } from "../auth/auth.guard";
import { CurrentUserId } from "../auth/current-user.decorator";
import { TutorExceptionFilter } from "../common/filters/tutor-exception.filter";
import { validateTutorAskRequest } from "./schemas/tutor-request";
import { TutorService } from "./tutor.service";

@Controller("tutor")
@UseFilters(TutorExceptionFilter)
@UseGuards(AuthGuard)
@AuthErrorFormat("tutor")
export class TutorController {
  constructor(
    @Inject(TutorService) private readonly tutorService: TutorService,
  ) {}

  @Post("ask")
  @HttpCode(200)
  async ask(@CurrentUserId() userId: string, @Body() body: unknown) {
    const validated = validateTutorAskRequest(body);
    const result = await this.tutorService.ask(userId, validated);

    return {
      answer: result.answer,
      cached: result.cached,
      conversationId: result.conversationId,
      conversationTitle: result.conversationTitle,
      ...(result.provider ? { provider: result.provider } : {}),
    };
  }
}
