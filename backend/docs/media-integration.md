# Shared media integration contract

`MediaModule` owns upload validation, storage, and media metadata. Blog,
itinerary, and profile features must not write files directly.

## Upload

`POST /api/media` is authenticated and accepts `multipart/form-data`:

- `file`: one JPG, JPEG, or PNG image; maximum 5 MB. Multer rejects
  additional files and oversized multipart payloads before service handling.
  The service also validates the image signature and basic structure, so a
  filename or client MIME type cannot make arbitrary bytes an image.
- `targetType`: `profile`, `hotel`, `airline`, `post`, `itinerary`, or `comment`.
- `targetId`: a MongoDB ObjectId for content targets. It is optional only for
  `profile`.

The authenticated user's ID is always persisted as `ownerId`. The response
contains a media ID and an API URL, never a local filesystem path or storage
credential.

## Reading

`GET /api/media/:id/content` is authenticated and owner-scoped for profile,
post, and comment media. Cross-user access is rejected. `POST /api/posts/:id/images`
and `DELETE /api/posts/:id/images/:imageId` provide the BLG-10 post attachment
routes. Post authors may attach up to five images; the limit is enforced with
an atomic post update. Comment uploads are also author-scoped.

`GET /api/media/public/:id/content` serves hotel/airline media and media for
published posts or visible comments on published posts. The service rechecks
target visibility on each read. Draft, hidden, and deleted post media is not
publicly readable. Profile media remains private. Itinerary uploads remain
disabled until the itinerary image ownership/count contract is implemented.

## Storage configuration

The development provider stores files under `MEDIA_STORAGE_PATH`
(`uploads/media` by default). Production deployments should replace
`LocalMediaStorage` with an implementation of `MediaStorageProvider` backed by
object storage, without changing controllers or consumers.
