import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { Report, ReportSchema } from './schemas/report.schema';
import { AdminCommunityController } from './reports.controller';
import { BlogModule } from '../blog/blog.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { Post, PostSchema } from '../blog/schemas/post.schema';
import { Comment, CommentSchema } from '../blog/schemas/comment.schema';
import { Review, ReviewSchema } from '../hotels/schemas/review.schema';
import {
  Itinerary,
  ItinerarySchema,
} from '../itineraries/schemas/itinerary.schema';

@Module({
  imports: [
    BlogModule,
    AuditLogsModule,
    MongooseModule.forFeature([
      { name: Report.name, schema: ReportSchema },
      { name: Post.name, schema: PostSchema },
      { name: Comment.name, schema: CommentSchema },
      { name: Review.name, schema: ReviewSchema },
      { name: Itinerary.name, schema: ItinerarySchema },
    ]),
  ],
  controllers: [ReportsController, AdminCommunityController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
