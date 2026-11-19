import { Module } from "@nestjs/common";
import { TutorModule } from "../tutor/tutor.module";
import { InterviewAiController } from "./interview-ai.controller";
import { InterviewAiService } from "./interview-ai.service";

@Module({
  imports: [TutorModule],
  controllers: [InterviewAiController],
  providers: [InterviewAiService],
  exports: [InterviewAiService],
})
export class InterviewAiModule {}
