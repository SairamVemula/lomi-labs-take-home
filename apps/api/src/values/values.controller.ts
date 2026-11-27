import { Body, Controller, Inject, Param, Post } from "@nestjs/common";
import type { User } from "@lomi/db";
import { ReviewRequest, type ValueView } from "@lomi/shared";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { DocumentsService } from "../documents/documents.service.js";
import { ApiError } from "../errors.js";
import { UuidPipe } from "../params.js";

@Controller("values")
export class ValuesController {
  constructor(@Inject(DocumentsService) private readonly docs: DocumentsService) {}

  @Post(":id/review")
  review(@CurrentUser() user: User, @Param("id", new UuidPipe()) id: string, @Body() body: unknown): Promise<ValueView> {
    const parsed = ReviewRequest.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "BAD_REQUEST", 'body must be {"action":"approve"} or {"action":"correct","value":...}');
    }
    return this.docs.review(user.id, id, parsed.data);
  }
}
