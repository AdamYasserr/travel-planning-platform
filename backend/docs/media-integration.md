# Shared media integration contract

`MediaModule` owns upload validation, storage, and media metadata. Blog,
itinerary, and profile features must not write files directly.

## Upload

`POST /api/media` is authenticated and accepts multipart form data:

- `file`: one JPG, JPEG, or PNG image; maximum 5 MB. Multer rejects additional
  files and oversized multipart payloads before service handling. The service
  also validates the extension, MIME type, image signature, and decoded image.
- `targetType`: `profile`, `activity`, or `post`.
- `targetId`: a MongoDB ObjectId required for activity and post images; omitted
  only for profile images.
- Post images are limited to five per post and can only be attached by its
  author.

The authenticated user's ID is persisted as `ownerId`. The response contains a
media ID and API URL, never a local filesystem path or storage credential.

## Reading and removal

- `GET /api/media/:id/content` is authenticated and owner-scoped.
- `GET /api/media/public/:id/content` serves only an image that remains
  attached to its owning, Published, non-hidden post. It verifies both the
  media-to-post reference and the post-author/media-owner match.
- `DELETE /api/media/posts/:postId/images/:imageId` removes an image only for
  its post author.

## Storage cleanup

Post and activity media metadata is marked pending before storage cleanup. The
local provider queues failed file removals under
`MEDIA_STORAGE_PATH/.pending-cleanups`; a scheduled retry processes queued
files and pending metadata once per minute. Delete responses identify when
cleanup remains pending. Failed upload cleanup uses the same file queue.

The queue is stored on the same filesystem as local media. If that filesystem
cannot persist the queue, cleanup cannot be guaranteed and the API reports a
cleanup failure for database-backed media instead of claiming the file was
removed. Production deployments should replace `LocalMediaStorage` with an
appropriate durable object-storage provider and retry mechanism.

## Database requirements

The documented runtime database is MongoDB Atlas, which supports transactions.
Post deletion and post-image removal use MongoDB transactions. Configure a
transaction-capable MongoDB deployment. `MONGODB_TEST_URI` can be set to a
dedicated transaction-capable test deployment to run the real-database
concurrency and rollback tests in `src/modules/blog/blog.mongo.integration.spec.ts`.
