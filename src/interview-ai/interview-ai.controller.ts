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
import { InterviewAiService } from "./interview-ai.service";
import { validateInterviewExplainRequest } from "./schemas";

@Controller("interview/ai")
@UseFilters(TutorExceptionFilter)
@UseGuards(AuthGuard)
@AuthErrorFormat("tutor")
export class InterviewAiController {
  constructor(
    @Inject(InterviewAiService)
    private readonly interviewAiService: InterviewAiService,
  ) {}

  @Post("explain")
  @HttpCode(200)
  async explain(@CurrentUserId() userId: string, @Body() body: unknown) {
    const validated = validateInterviewExplainRequest(body);
    const result = await this.interviewAiService.explain(userId, validated);

    return {
      answer: result.answer,
      cached: result.cached,
      relatedLesson: result.relatedLesson,
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.conversationId
        ? { conversationId: result.conversationId }
        : {}),
      ...(result.conversationTitle
        ? { conversationTitle: result.conversationTitle }
        : {}),
    };
  }
}
