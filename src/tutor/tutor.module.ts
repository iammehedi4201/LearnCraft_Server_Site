import { Module } from "@nestjs/common";
import { TutorCacheService } from "./cache/tutor-cache.service";
import { HistoryController } from "./history.controller";
import { ConversationStoreService } from "./history/conversation-store.service";
import { HistoryService } from "./history.service";
import { LlmRouterService } from "./llm/llm-router.service";
import { TutorController } from "./tutor.controller";
import { TutorService } from "./tutor.service";
import { TutorUsageService } from "./usage/tutor-usage.service";

@Module({
  controllers: [TutorController, HistoryController],
  providers: [
    TutorCacheService,
    TutorUsageService,
    ConversationStoreService,
    LlmRouterService,
    TutorService,
    HistoryService,
  ],
  exports: [
    TutorCacheService,
    TutorUsageService,
    ConversationStoreService,
    LlmRouterService,
    TutorService,
    HistoryService,
  ],
})
export class TutorModule {}
