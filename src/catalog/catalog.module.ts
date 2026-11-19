import { Global, Module } from "@nestjs/common";
import { LessonRegistryService } from "./lesson-registry.service";
import { QuestionRegistryService } from "./question-registry.service";

@Global()
@Module({
  providers: [LessonRegistryService, QuestionRegistryService],
  exports: [LessonRegistryService, QuestionRegistryService],
})
export class CatalogModule {}
