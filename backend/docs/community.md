# Blog, community, and moderation

## Requirements reviewed

The project-description PDF identifies BLG-01–12 for draft/published posts, public browsing, author pages, comments, unique likes, tags/search, author editing/deletion, and post images. It also specifies GEN-09/10 reports and administrator dismissal, hide/delete, and audit logging. The Excel workbook is not available in the project files; exact workbook acceptance criteria and numeric limits beyond the checked-in GIU test-case notes remain unverified. Optional BLG-13 itinerary attachment is not implemented.

Implementation choices where the workbook is needed:

- Post titles are limited to 160 characters, post bodies to 20,000, comments to 5,000, tags to 10 per post and 30 characters each. These are defensive API limits, not claimed workbook limits.
- New posts default to `draft`. Public listing and detail expose only `published` posts. Drafts are visible to their author through `/mine` and the detail route.
- Author and comment deletion, and administrator deletion, mark content deleted so reports and audit references remain. Deleted posts also have comments and likes deactivated, and their media files are removed.
- Only administrators can review reports or moderate content, consistent with the PDF role description. Hotel and airline moderators cannot moderate community posts.
- Duplicate likes and duplicate reports return `409` through unique indexes.

## API

Cookie JWT authentication is required except for public browse/detail routes, public author/tag pages, public comments, and public post media. The API prefix is `/api`.

| Method | Route | Access and behavior |
| --- | --- | --- |
| `POST` | `/api/posts` | Authenticated user creates a draft or published post. |
| `GET` | `/api/posts` | Public published-post search/filter/sort/pagination (`q`, `tag`, `authorId`, `page`, `limit`, `sort`). |
| `GET` | `/api/posts/:id` | Public published post; an optional valid cookie lets the author read their own draft. |
| `GET` | `/api/posts/mine` | Authenticated author’s drafts and published posts. |
| `PATCH`, `DELETE` | `/api/posts/:id` | Author-only update or soft-delete. |
| `POST`, `GET` | `/api/posts/:id/comments` | Authenticated comment creation; public paginated listing for published posts. |
| `PATCH`, `DELETE` | `/api/comments/:id` | Comment-author-only edit or delete. |
| `POST`, `DELETE` | `/api/posts/:id/like` | Add/remove the authenticated user’s like. Duplicate add returns `409`. |
| `POST`, `DELETE` | `/api/posts/:id/images`, `/api/posts/:id/images/:imageId` | Author-only JPG/PNG image upload/removal. Five images maximum per post. |
| `GET` | `/api/tags/:tag/posts` | Public posts for a validated tag. |
| `GET` | `/api/authors/:id` | Public author summary and published posts. |
| `POST` | `/api/reports` | Authenticated report submission for existing public posts, visible comments, reviews, or public itineraries. Duplicate target reports return `409`. |
| `GET` | `/api/admin/reports` | Admin-only paginated report queue, optionally filtered by `status`. |
| `PATCH` | `/api/admin/reports/:id` | Admin dismisses a report or hides/deletes its target. Body: `{ "action": "dismiss|hide|delete", "note": "optional" }`. |
| `DELETE` | `/api/admin/content/:type/:id` | Admin soft-deletes a post/comment or removes a review/public itinerary. Supported types: `post`, `comment`, `review`, `itinerary`. |
| `GET` | `/api/admin/audit-logs` | Admin-only paginated audit history; optional `action` and `targetType` filters. |

The existing `POST /api/media` also supports `targetType=post|comment` with an owner-authorized `targetId`. Public images are served through `/api/media/public/:id/content`; drafts, hidden content, and deleted content do not expose media publicly. The post-specific route is the documented BLG-10 API.

## Moderation and audit behavior

Every report records its reporter, target, reason, and open/resolved state. A unique reporter/type/target index prevents duplicate reports. Moderation records the administrator, action, time, and optional note on the report. Hide/delete actions for posts/comments/reviews/public itineraries and report dismissal/resolution also create audit log entries. Hiding a post/comment removes it from public reads; deleted posts/comments retain tombstones for report references, while deleting a review or itinerary removes that document and keeps the report record.

Media ownership is checked against the post/comment author. Public media reads re-check that a post is published, or that a comment is visible under a published post. Uploads use the existing image-signature, decode, MIME, extension, and 5 MB validation. Post media count is guarded with an atomic conditional update to prevent concurrent uploads exceeding five.
